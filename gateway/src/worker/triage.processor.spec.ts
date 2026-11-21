import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { type Job, UnrecoverableError } from 'bullmq';
import { vi } from 'vitest';
import type { TicketJobData } from '../queue/triage-queue.service.js';
import { RetryableTriageError } from './triage.errors.js';
import { TriageProcessor } from './triage.processor.js';

const SUBJECT = 'SECRET-SUBJECT-777';
const BODY = 'SECRET-BODY-888';
const DATA: TicketJobData = {
  subject: SUBJECT,
  body: BODY,
  customer_id: 'c1',
  received_at: '2026-11-20T10:00:00.000Z',
};

const settings = {
  TRIAGE_SERVICE_URL: 'http://app:8000',
  TRIAGE_TIMEOUT_MS: 1000,
  WORKER_CONCURRENCY: 3,
};
const config = { get: (key: keyof typeof settings) => settings[key] } as unknown as ConfigService<never, true>;

const job = (attemptsMade = 0) =>
  ({ id: 'job-1', data: DATA, attemptsMade, opts: { attempts: 5 } }) as unknown as Job<TicketJobData>;

const reply = (status: number, text: string, headers: Record<string, string> = {}) =>
  vi.fn(async () => new Response(text, { status, headers })) as unknown as typeof fetch;

describe('TriageProcessor.process', () => {
  afterEach(() => vi.restoreAllMocks());

  it('success -> returns the parsed response as the job result', async () => {
    const result = { ticket_id: 't-1', reference: 'TIQ-ABC' };
    const processor = new TriageProcessor(config, reply(200, JSON.stringify(result)));
    await expect(processor.process(job())).resolves.toEqual(result);
  });

  it('sends subject, body and customer_id (not received_at) to the Python service', async () => {
    const fetchFn = reply(200, '{}');
    await new TriageProcessor(config, fetchFn).process(job());
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://app:8000/triage');
    expect(JSON.parse(init.body as string)).toEqual({ subject: SUBJECT, body: BODY, customer_id: 'c1' });
  });

  it('503 with Retry-After -> throws a retryable error that carries the seconds', async () => {
    const processor = new TriageProcessor(config, reply(503, '{}', { 'Retry-After': '30' }));
    const error = await processor.process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryableTriageError);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect((error as RetryableTriageError).message).toBe('triage service unavailable (503)');
    expect((error as RetryableTriageError).retryAfterSeconds).toBe(30);
  });

  it.each([
    [422, 'rejected by triage service (422)'],
    [404, 'rejected by triage service (404)'],
    [500, 'triage service error (500)'],
  ])('%i -> throws UnrecoverableError, so BullMQ does not retry', async (status, reason) => {
    const error = await new TriageProcessor(config, reply(status, '{}')).process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toBe(reason);
  });

  it('2xx with invalid JSON -> UnrecoverableError', async () => {
    const error = await new TriageProcessor(config, reply(200, 'nope')).process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toBe('invalid response from triage service');
  });

  it('a connection failure -> retryable error with a fixed reason', async () => {
    const fetchFn = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:8000'), { code: 'ECONNREFUSED' }),
      });
    }) as unknown as typeof fetch;
    const error = await new TriageProcessor(config, fetchFn).process(job()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RetryableTriageError);
    expect((error as Error).message).toBe('triage service unreachable (connection refused)');
    expect((error as Error).message).not.toMatch(/10\.0\.0\.5|app:8000/);
  });

  it('logs job id, attempt, outcome and duration, and never the subject or body', async () => {
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => void lines.push(String(message)));
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => void lines.push(String(message)));

    await new TriageProcessor(config, reply(200, '{}')).process(job(0));
    await new TriageProcessor(config, reply(503, '{}')).process(job(2)).catch(() => undefined);
    await new TriageProcessor(config, reply(422, `{"input":"${BODY}"}`)).process(job(0)).catch(() => undefined);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^job=job-1 attempt=1\/5 outcome=success duration_ms=\d+$/);
    expect(lines[1]).toMatch(/^job=job-1 attempt=3\/5 outcome=retry \(triage service unavailable \(503\)\) duration_ms=\d+$/);
    expect(lines[2]).toMatch(/attempt=1\/5 outcome=fail \(rejected by triage service \(422\)\)/);
    for (const line of lines) {
      expect(line).not.toContain(SUBJECT);
      expect(line).not.toContain(BODY);
    }
  });
});

describe('TriageProcessor attempts in the log line', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows 1 as the total for a job created before attempts existed, never "/0"', async () => {
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => void lines.push(String(message)));
    const old = { id: 'job-old', data: DATA, attemptsMade: 0, opts: {} } as unknown as Job<TicketJobData>;
    await new TriageProcessor(config, reply(200, '{}')).process(old);
    expect(lines[0]).toMatch(/^job=job-old attempt=1\/1 outcome=success/);
  });
});

describe('TriageProcessor dead-letter log', () => {
  afterEach(() => vi.restoreAllMocks());

  const failedJob = (state: string | Error, attemptsMade = 8) =>
    ({
      id: 'job-9',
      data: DATA,
      attemptsMade,
      getState: () => (state instanceof Error ? Promise.reject(state) : Promise.resolve(state)),
    }) as unknown as Job<TicketJobData>;

  function warnings() {
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => void lines.push(String(message)));
    return lines;
  }
  const processor = () => new TriageProcessor(config, reply(200, '{}'));

  it('logs one WARN line with job id, attempts made and the short reason when the job is failed', async () => {
    const lines = warnings();
    await processor().onFailed(failedJob('failed'), new Error('triage service unavailable (503)\n    at x (/app/y.js:1:1)'));
    expect(lines).toEqual(['dead-letter job=job-9 attempts_made=8 reason=triage service unavailable (503)']);
  });

  it('says nothing for an attempt that will be retried (state delayed)', async () => {
    const lines = warnings();
    await processor().onFailed(failedJob('delayed', 1), new Error('triage service unavailable (503)'));
    expect(lines).toEqual([]);
  });

  it('says nothing when the state cannot be read, or there is no job', async () => {
    const lines = warnings();
    await processor().onFailed(failedJob(new Error('Connection is closed.')), new Error('x'));
    await processor().onFailed(undefined, new Error('x'));
    expect(lines).toEqual([]);
  });

  it('never contains ticket text', async () => {
    const lines = warnings();
    await processor().onFailed(failedJob('failed'), new Error('rejected by triage service (422)'));
    for (const line of lines) {
      expect(line).not.toContain(SUBJECT);
      expect(line).not.toContain(BODY);
    }
  });
});
