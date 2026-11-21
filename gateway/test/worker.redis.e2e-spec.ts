import { type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, vi } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { stubEnv } from './app-helpers.js';
import { api } from './auth-helpers.js';

/**
 * The real app WITH its worker, a REAL Redis, and a fake triage server started in the test.
 * Skipped unless REDIS_TEST_URL is set, e.g.
 *   docker run --rm -d --name gw-redis-test -p 6390:6379 redis:8.10.3-alpine
 *   REDIS_TEST_URL=redis://localhost:6390 npm run test:e2e
 * The retry tests use the real backoff (10 s after the first failure), so they take a while.
 * It removes the jobs it creates and never flushes the database.
 */
const REDIS_TEST_URL = process.env.REDIS_TEST_URL;

interface Hit {
  subject: string;
  at: number;
  keys: string[];
  ticketId?: string;
}

const SLOW = 40_000;

describe.skipIf(!REDIS_TEST_URL)('triage worker against a real Redis and a fake triage server', () => {
  const RESULT = { ticket_id: 't-1', reference: 'TIQ-ABC123', category: 'billing', needs_human_review: false };

  const hits: Hit[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let abortedByClient = 0;
  let server: Server;
  let app: NestExpressApplication;
  let inspector: Queue;
  const created: string[] = [];

  const callsFor = (subject: string) => hits.filter((hit) => hit.subject === subject);

  function respond(ticket: { subject: string }, nth: number, res: ServerResponse) {
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    switch (ticket.subject) {
      case 'S-503':
        return nth === 1 ? json(503, { detail: 'busy' }, { 'Retry-After': '1' }) : json(200, RESULT);
      case 'S-RA20':
        return json(503, { detail: 'busy' }, { 'Retry-After': '20' });
      case 'S-422':
        return json(422, { detail: [{ msg: 'bad' }] });
      case 'S-500':
        return json(500, { detail: 'Internal Server Error' });
      case 'S-HANG':
        return nth === 1 ? undefined : json(200, RESULT); // the first call never answers
      default:
        if (ticket.subject.startsWith('S-CONC')) return void setTimeout(() => json(200, RESULT), 700);
        return json(200, RESULT);
    }
  }

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += String(chunk)));
      req.on('end', () => {
        const ticket = JSON.parse(raw) as { subject: string };
        hits.push({
          subject: ticket.subject,
          at: Date.now(),
          keys: Object.keys(ticket),
          ticketId: (ticket as { ticket_id?: string }).ticket_id,
        });
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        res.on('close', () => {
          inFlight -= 1;
          if (!res.writableEnded) abortedByClient += 1;
        });
        respond(ticket, callsFor(ticket.subject).length, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    stubEnv(REDIS_TEST_URL);
    vi.stubEnv('TRIAGE_SERVICE_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('WORKER_CONCURRENCY', '2');
    vi.stubEnv('TRIAGE_TIMEOUT_MS', '1000');

    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.init();
    inspector = new Queue('triage', { connection: { url: REDIS_TEST_URL } });
  });

  afterAll(async () => {
    for (const id of created) {
      await (await inspector?.getJob(id))?.remove().catch(() => undefined);
    }
    await inspector?.close();
    await app?.close();
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    vi.unstubAllEnvs();
  });

  async function submit(subject: string): Promise<string> {
    const response = await api(app)
      .post('/tickets')
      .send({ subject, body: 'Please help', customer_id: 'cust-1' })
      .expect(202);
    created.push(response.body.job_id);
    return response.body.job_id;
  }

  async function status(id: string) {
    return (await api(app).get(`/jobs/${id}`).expect(200)).body;
  }

  async function waitFor(id: string, wanted: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const body = await status(id);
      if (body.status === wanted) return body;
      if (Date.now() > deadline) throw new Error(`job stayed "${body.status}", wanted "${wanted}"`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  it('success -> done, and GET /jobs/:id returns the triage result', async () => {
    const id = await submit('S-OK');
    const body = await waitFor(id, 'done', 10_000);

    expect(body).toEqual({
      job_id: id,
      status: 'done',
      received_at: expect.any(String),
      result: RESULT,
    });
    expect(callsFor('S-OK')).toHaveLength(1);
    // The Python service gets exactly the TicketIn fields, and the job id as ticket_id.
    expect(callsFor('S-OK')[0].keys.sort()).toEqual(['body', 'customer_id', 'reference', 'subject', 'ticket_id']);
    expect(callsFor('S-OK')[0].ticketId).toBe(id);
  });

  it(
    '503 with Retry-After: 1, then 200 -> retried and done, the second attempt later than the first',
    async () => {
      const id = await submit('S-503');
      const body = await waitFor(id, 'done', 30_000);

      expect(body.result).toEqual(RESULT);
      const [first, second] = callsFor('S-503');
      expect(callsFor('S-503')).toHaveLength(2);
      // The same ticket_id, equal to the job id, on the first attempt and on the retry.
      expect(first.ticketId).toBe(id);
      expect(second.ticketId).toBe(id);
      expect(second.at - first.at).toBeGreaterThanOrEqual(1000); // at least the Retry-After
      expect(second.at - first.at).toBeGreaterThanOrEqual(9000); // in fact the 10 s base backoff
      expect((await inspector.getJob(id))?.attemptsMade).toBe(2); // the failed try and the good one
    },
    SLOW,
  );

  it('422 -> failed after exactly 1 attempt, with a short fixed reason', async () => {
    const id = await submit('S-422');
    const body = await waitFor(id, 'failed', 10_000);

    expect(body.error).toBe('rejected by triage service (422)');
    expect(body).not.toHaveProperty('result');
    await new Promise((resolve) => setTimeout(resolve, 1500)); // a retry would show up by now
    expect(callsFor('S-422')).toHaveLength(1);
    expect((await inspector.getJob(id))?.attemptsMade).toBe(1);
  });

  it('500 -> failed after exactly 1 attempt (a retry could not fix it)', async () => {
    const id = await submit('S-500');
    const body = await waitFor(id, 'failed', 10_000);

    expect(body.error).toBe('triage service error (500)');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(callsFor('S-500')).toHaveLength(1);
    expect((await inspector.getJob(id))?.attemptsMade).toBe(1);
  });

  it(
    'a hanging server -> timeout -> retried -> done',
    async () => {
      const abortedBefore = abortedByClient;
      const id = await submit('S-HANG');
      const body = await waitFor(id, 'done', 35_000);

      expect(body.result).toEqual(RESULT);
      expect(callsFor('S-HANG')).toHaveLength(2);
      expect(abortedByClient).toBeGreaterThan(abortedBefore); // the worker cut the first call off
      const [first, second] = callsFor('S-HANG');
      expect(second.at - first.at).toBeGreaterThanOrEqual(10_000); // 1 s timeout + 10 s backoff
    },
    SLOW,
  );

  it('the Retry-After from the Python service reaches the backoff (20 s, not the 10 s base)', async () => {
    const id = await submit('S-RA20');
    const deadline = Date.now() + 10_000;
    while ((await (await inspector.getJob(id))?.getState()) !== 'delayed') {
      if (Date.now() > deadline) throw new Error('job never became delayed');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    // BullMQ keeps delayed jobs in a sorted set; the score is (due time in ms) * 4096 + counter.
    const redis = new Redis(REDIS_TEST_URL as string);
    const score = Number(await redis.zscore('bull:triage:delayed', id));
    redis.disconnect();
    const dueInMs = Math.floor(score / 4096) - Date.now();
    expect(dueInMs).toBeGreaterThan(15_000);
    expect(dueInMs).toBeLessThanOrEqual(20_500);
    expect((await status(id)).status).toBe('queued'); // delayed counts as queued

    await (await inspector.getJob(id))?.remove(); // so it is not retried after the test
    expect(callsFor('S-RA20')).toHaveLength(1);
  });

  it('concurrency 2 with 4 jobs -> never more than 2 in flight at the fake server', async () => {
    maxInFlight = 0;
    const ids = await Promise.all([1, 2, 3, 4].map((n) => submit(`S-CONC-${n}`)));
    await Promise.all(ids.map((id) => waitFor(id, 'done', 15_000)));

    expect(callsFor('S-CONC-1')).toHaveLength(1);
    expect(maxInFlight).toBe(2); // two ran together, and never three
    // Two waves of 700 ms: the third request cannot start before the first has answered.
    const starts = [1, 2, 3, 4].map((n) => callsFor(`S-CONC-${n}`)[0].at).sort((a, b) => a - b);
    expect(starts[2] - starts[0]).toBeGreaterThanOrEqual(600);
  });
});
