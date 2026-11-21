import { Logger } from '@nestjs/common';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, vi } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { TRIAGE_RETRY_POLICY } from '../src/queue/retry-policy.js';
import { stubEnv } from './app-helpers.js';
import { api } from './auth-helpers.js';

/**
 * Dead-letter list and retry against a REAL Redis and a fake triage server.
 * Skipped unless REDIS_TEST_URL is set, e.g.
 *   docker run --rm -d --name gw-redis-test -p 6390:6379 redis:8.10.3-alpine
 *   REDIS_TEST_URL=redis://localhost:6390 npm run test:e2e
 * The retry policy is replaced by the test (3 attempts, 50 ms first backoff), so exhausting a
 * job's attempts takes well under a second instead of 15 minutes. It removes the jobs it
 * creates and never flushes the database.
 */
const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
const ATTEMPTS = 3;

describe.skipIf(!REDIS_TEST_URL)('dead letters against a real Redis and a fake triage server', () => {
  const RESULT = { ticket_id: 't-1', reference: 'TIQ-ABC123', category: 'billing' };

  const hits: string[] = [];
  /** Subjects the fake server has been "fixed" for: they get 200 instead of 503. */
  const fixed = new Set<string>();
  let server: Server;
  let app: NestExpressApplication;
  let inspector: Queue;
  const created: string[] = [];
  const warnings: string[] = [];

  const callsFor = (subject: string) => hits.filter((hit) => hit === subject).length;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += String(chunk)));
      req.on('end', () => {
        const { subject } = JSON.parse(raw) as { subject: string };
        hits.push(subject);
        const json = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (subject.startsWith('DL-422')) return json(422, { detail: [{ msg: 'bad' }] });
        if (fixed.has(subject)) return json(200, RESULT);
        return json(503, { detail: 'busy' });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    stubEnv(REDIS_TEST_URL);
    vi.stubEnv('TRIAGE_SERVICE_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('WORKER_CONCURRENCY', '2');
    vi.stubEnv('TRIAGE_TIMEOUT_MS', '1000');

    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TRIAGE_RETRY_POLICY)
      .useValue({ attempts: ATTEMPTS, backoffBaseMs: 50 })
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.init();
    inspector = new Queue('triage', { connection: { url: REDIS_TEST_URL } });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(String(message));
    });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
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

  async function waitForStatus(id: string, wanted: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const body = (await api(app).get(`/jobs/${id}`).expect(200)).body;
      if (body.status === wanted) return body;
      if (Date.now() > deadline) throw new Error(`job stayed "${body.status}", wanted "${wanted}"`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async function list(query = '') {
    return (await api(app).get(`/dead-letters${query}`).expect(200)).body;
  }

  it('a 422 fails the job at once and it shows up with the right fields', async () => {
    const id = await submit('DL-422-a');
    await waitForStatus(id, 'failed');

    const { items, total } = await list('?limit=100');
    const item = items.find((entry: { job_id: string }) => entry.job_id === id);
    expect(total).toBeGreaterThanOrEqual(1);
    expect(item).toEqual({
      job_id: id,
      failed_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
      received_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
      attempts_made: 1,
      reason: 'rejected by triage service (422)',
      subject: 'DL-422-a',
      body: 'Please help',
      customer_id: 'cust-1',
      client: 'ops', // the API client that submitted it
    });
    expect(callsFor('DL-422-a')).toBe(1);
    expect(warnings).toContain(`dead-letter job=${id} attempts_made=1 reason=rejected by triage service (422)`);
  });

  it('exhausted retries (always 503) end up listed with attempts_made equal to the attempt count, logged once', async () => {
    const id = await submit('DL-503-a');
    await waitForStatus(id, 'failed');

    const { items } = await list('?limit=100');
    const item = items.find((entry: { job_id: string }) => entry.job_id === id);
    expect(item).toMatchObject({
      attempts_made: ATTEMPTS,
      reason: 'triage service unavailable (503)',
      subject: 'DL-503-a',
    });
    expect(callsFor('DL-503-a')).toBe(ATTEMPTS);
    // One line when the job is final; the attempts that were retried log nothing here.
    expect(warnings.filter((line) => line.startsWith(`dead-letter job=${id} `))).toEqual([
      `dead-letter job=${id} attempts_made=${ATTEMPTS} reason=triage service unavailable (503)`,
    ]);
  });

  it('retry: the same job id goes queued -> done and leaves the list', async () => {
    const id = await submit('DL-FIX-a');
    await waitForStatus(id, 'failed');
    expect(callsFor('DL-FIX-a')).toBe(ATTEMPTS);

    fixed.add('DL-FIX-a'); // the triage service "recovers"
    const response = await api(app).post(`/dead-letters/${id}/retry`).expect(202);
    expect(response.body).toEqual({ job_id: id, status: 'queued', status_url: `/jobs/${id}` });

    const done = await waitForStatus(id, 'done');
    expect(done.result).toEqual(RESULT);
    expect(callsFor('DL-FIX-a')).toBe(ATTEMPTS + 1);

    const { items } = await list('?limit=100');
    expect(items.some((entry: { job_id: string }) => entry.job_id === id)).toBe(false);
    // BullMQ's counter was reset by the retry: one attempt since, not ATTEMPTS + 1.
    expect((await inspector.getJob(id))?.attemptsMade).toBe(1);
  });

  it('retry gives a FULL set of attempts again: still failing -> ATTEMPTS more tries', async () => {
    const id = await submit('DL-AGAIN-a');
    await waitForStatus(id, 'failed');
    expect(callsFor('DL-AGAIN-a')).toBe(ATTEMPTS);

    await api(app).post(`/dead-letters/${id}/retry`).expect(202);
    // Wait for the second failure: its dead-letter log line (the first one is already there).
    const deadline = Date.now() + 10_000;
    while (
      warnings.filter((line) => line.startsWith(`dead-letter job=${id} `)).length < 2 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(callsFor('DL-AGAIN-a')).toBe(ATTEMPTS * 2);
    const { items } = await list('?limit=100');
    expect(items.find((entry: { job_id: string }) => entry.job_id === id)).toMatchObject({
      attempts_made: ATTEMPTS,
    });
  });

  it('retrying twice in a row: the second call gets 409', async () => {
    const id = await submit('DL-FIX-b');
    await waitForStatus(id, 'failed');
    fixed.add('DL-FIX-b');

    await api(app).post(`/dead-letters/${id}/retry`).expect(202);
    const second = await api(app).post(`/dead-letters/${id}/retry`).expect(409);
    expect(second.body).toEqual({ detail: 'Job is not in the dead-letter list' });

    await waitForStatus(id, 'done');
    await api(app).post(`/dead-letters/${id}/retry`).expect(409); // done is not failed
    expect(callsFor('DL-FIX-b')).toBe(ATTEMPTS + 1); // one retry ran, not two
  });

  it('two retries at the same moment: exactly one wins', async () => {
    const id = await submit('DL-FIX-c');
    await waitForStatus(id, 'failed');
    fixed.add('DL-FIX-c');

    const answers = await Promise.all([
      api(app).post(`/dead-letters/${id}/retry`),
      api(app).post(`/dead-letters/${id}/retry`),
    ]);
    expect(answers.map((answer) => answer.status).sort((a, b) => a - b)).toEqual([202, 409]);
    await waitForStatus(id, 'done');
    expect(callsFor('DL-FIX-c')).toBe(ATTEMPTS + 1);
  });

  it('unknown id -> 404, malformed id -> 400, a queued/done job -> 409', async () => {
    await api(app)
      .post('/dead-letters/3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34/retry')
      .expect(404);
    await api(app).post('/dead-letters/not-an-id/retry').expect(400);

    const id = await submit('DL-OK-a');
    fixed.add('DL-OK-a');
    await waitForStatus(id, 'done');
    await api(app).post(`/dead-letters/${id}/retry`).expect(409);
  });

  it('pagination across 3 failed jobs, newest failure first', async () => {
    const before = (await list('?limit=1')).total;
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const id = await submit(`DL-422-page-${n}`);
      await waitForStatus(id, 'failed');
      ids.push(id);
      await new Promise((resolve) => setTimeout(resolve, 15)); // distinct failure times
    }

    const first = await list('?limit=2&offset=0');
    expect(first.total).toBe(before + 3);
    expect(first.limit).toBe(2);
    expect(first.offset).toBe(0);
    expect(first.items.map((item: { job_id: string }) => item.job_id)).toEqual([ids[2], ids[1]]);

    const second = await list('?limit=2&offset=2');
    expect(second.items[0].job_id).toBe(ids[0]);
    expect(second.offset).toBe(2);

    const times = first.items.map((item: { failed_at: string }) => Date.parse(item.failed_at));
    expect(times[0]).toBeGreaterThanOrEqual(times[1]);
  });

  it('bad query values -> 400', async () => {
    await api(app).get('/dead-letters?limit=0').expect(400);
    await api(app).get('/dead-letters?limit=101').expect(400);
    await api(app).get('/dead-letters?offset=-1').expect(400);
    await api(app).get('/dead-letters?limit=abc').expect(400);
  });
});
