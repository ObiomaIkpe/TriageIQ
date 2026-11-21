import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, vi } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { stubEnv } from './app-helpers.js';
import { api } from './auth-helpers.js';

/**
 * Shutting the app down while a job is running must let that job finish.
 * (A first version of the worker's close() abandoned running jobs, and nothing noticed.)
 * Real Redis, skipped unless REDIS_TEST_URL is set.
 */
const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
const SERVER_DELAY_MS = 2500;

describe.skipIf(!REDIS_TEST_URL)('closing the app while a job is running', () => {
  let server: Server;
  let inspector: Queue;
  let app: NestExpressApplication | undefined;
  let jobId = '';
  let hits = 0;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += String(chunk)));
      req.on('end', () => {
        // Count only this test's ticket: the Redis may hold other jobs from earlier runs.
        if ((JSON.parse(raw) as { subject: string }).subject === 'S-SHUTDOWN') hits += 1;
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ticket_id: 't-shutdown' }));
        }, SERVER_DELAY_MS);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    stubEnv(REDIS_TEST_URL);
    vi.stubEnv('TRIAGE_SERVICE_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('TRIAGE_TIMEOUT_MS', '30000');

    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.init();
    inspector = new Queue('triage', { connection: { url: REDIS_TEST_URL } });
  });

  afterAll(async () => {
    if (jobId) await (await inspector?.getJob(jobId))?.remove().catch(() => undefined);
    await inspector?.close();
    await app?.close().catch(() => undefined);
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    vi.unstubAllEnvs();
  });

  it('app.close() waits for the running job, and the job ends up completed', async () => {
    const post = await api(app!)
      .post('/tickets')
      .send({ subject: 'S-SHUTDOWN', body: 'x' })
      .expect(202);
    jobId = post.body.job_id;

    // Wait until the worker really has the job and its request is in flight.
    const deadline = Date.now() + 10_000;
    while (hits === 0) {
      if (Date.now() > deadline) throw new Error('the worker never called the triage server');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await (await inspector.getJob(jobId))?.getState()).toBe('active');

    const started = Date.now();
    await app!.close();
    const took = Date.now() - started;
    app = undefined;

    expect(took).toBeGreaterThanOrEqual(1500); // it waited for the 2.5 s request
    expect(hits).toBe(1); // and did not send it a second time
    const job = await inspector.getJob(jobId);
    expect(await job?.getState()).toBe('completed');
    expect(job?.returnvalue).toEqual({ ticket_id: 't-shutdown' });
  }, 30_000);
});
