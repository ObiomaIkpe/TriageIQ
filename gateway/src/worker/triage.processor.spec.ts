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

describe('TriageProcessor sends the job id as ticket_id', () => {
  const ID = '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34';
  const withId = (id: string | undefined, attemptsMade = 0) =>
    ({ id, data: DATA, attemptsMade, opts: { attempts: 8 } }) as unknown as Job<TicketJobData>;
  const sent = (fetchFn: typeof fetch) =>
    JSON.parse(((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body as string);

  it('puts job.id in the body next to subject, body and customer_id', async () => {
    const fetchFn = reply(200, '{}');
    await new TriageProcessor(config, fetchFn).process(withId(ID));
    expect(sent(fetchFn)).toEqual({ subject: SUBJECT, body: BODY, customer_id: 'c1', ticket_id: ID });
  });

  it('sends the same value on a later attempt of the same job', async () => {
    const first = reply(200, '{}');
    const retry = reply(200, '{}');
    await new TriageProcessor(config, first).process(withId(ID, 0));
    await new TriageProcessor(config, retry).process(withId(ID, 3));
    expect(sent(retry).ticket_id).toBe(sent(first).ticket_id);
  });

  it.each(['job-1', '123', '', undefined])('an id that is not a UUID (%s) is left out, not sent', async (id) => {
    const fetchFn = reply(200, '{}');
    await new TriageProcessor(config, fetchFn).process(withId(id));
    expect(sent(fetchFn)).not.toHaveProperty('ticket_id');
  });
});

describe('TriageProcessor with a reference and contact details (public form)', () => {
  const ID = '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34';
  const PUBLIC_DATA: TicketJobData = { ...DATA, reference: 'TKT-ABC234', customer_name: 'Ọbiọma', customer_email: 'a@example.com' };
  const publicJob = { id: ID, data: PUBLIC_DATA, attemptsMade: 0, opts: { attempts: 8 } } as unknown as Job<TicketJobData>;
  const sent = (fetchFn: typeof fetch) =>
    JSON.parse(((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body as string);
  afterEach(() => vi.restoreAllMocks());

  it('sends reference, customer_name and customer_email to Python with the ticket', async () => {
    const fetchFn = reply(200, '{}');
    await new TriageProcessor(config, fetchFn).process(publicJob);
    expect(sent(fetchFn)).toEqual({
      subject: SUBJECT, body: BODY, customer_id: 'c1', ticket_id: ID,
      reference: 'TKT-ABC234', customer_name: 'Ọbiọma', customer_email: 'a@example.com',
    });
  });

  it('an older job with none of them sends none of them', async () => {
    const fetchFn = reply(200, '{}');
    await new TriageProcessor(config, fetchFn).process({ id: ID, data: DATA, attemptsMade: 0, opts: {} } as unknown as Job<TicketJobData>);
    expect(Object.keys(sent(fetchFn))).toEqual(['subject', 'body', 'customer_id', 'ticket_id']);
  });

  it('409 reference_conflict -> UnrecoverableError (dead letter) and a loud ERROR line with the reference but no ticket text', async () => {
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => void lines.push(String(m)));
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => void lines.push(String(m)));
    const fetchFn = reply(409, JSON.stringify({ detail: { code: 'reference_conflict', message: 'x' } }));
    const error = await new TriageProcessor(config, fetchFn).process(publicJob).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toBe('reference conflict');
    const log = lines.join('\n');
    expect(log).toContain('REFERENCE CONFLICT');
    expect(log).toContain('TKT-ABC234');
    expect(log).not.toMatch(/SECRET|a@example.com|Ọbiọma/);
  });

  it('any other 409 is an ordinary rejection, not the loud case', async () => {
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => void lines.push(String(m)));
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = await new TriageProcessor(config, reply(409, '{"detail":"other"}')).process(publicJob).catch((e: unknown) => e);
    expect((error as Error).message).toBe('rejected by triage service (409)');
    expect(lines).toEqual([]);
  });
});
