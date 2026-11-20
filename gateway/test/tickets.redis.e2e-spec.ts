import { Queue } from 'bullmq';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, vi } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { WorkerModule } from '../src/worker/worker.module.js';
import { NoWorkerModule, stubEnv } from './app-helpers.js';

/**
 * Runs against a REAL Redis. Skipped unless REDIS_TEST_URL is set, e.g.
 *   docker run --rm -d --name gw-redis-test -p 6390:6379 redis:8.10.3-alpine
 *   REDIS_TEST_URL=redis://localhost:6390 npm run test:e2e
 * It adds one job per test and removes it again. It never flushes the database.
 */
const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
const TICKET = { subject: '  Cannot log in ', body: 'I forgot my password.', customer_id: 'cust-42' };

describe.skipIf(!REDIS_TEST_URL)('ticket intake against a real Redis', () => {
  let app: NestExpressApplication;
  let inspector: Queue;
  const created: string[] = [];

  beforeAll(async () => {
    stubEnv(REDIS_TEST_URL);
    const { AppModule } = await import('../src/app.module.js');
    // No worker here: this file checks intake only, and a worker would take the job off the queue.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideModule(WorkerModule)
      .useModule(NoWorkerModule)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.init();
    // A second, independent connection, to look at what really landed in Redis.
    inspector = new Queue('triage', { connection: { url: REDIS_TEST_URL } });
  });

  afterAll(async () => {
    for (const id of created) await (await inspector?.getJob(id))?.remove();
    await inspector?.close();
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('POST stores the job in Redis, GET reports it queued, and the data matches', async () => {
    const before = Date.now();
    const post = await request(app.getHttpServer()).post('/tickets').send(TICKET).expect(202);
    const id: string = post.body.job_id;
    created.push(id);
    expect(post.headers.location).toBe(`/jobs/${id}`);

    const get = await request(app.getHttpServer()).get(`/jobs/${id}`).expect(200);
    expect(get.body).toEqual({
      job_id: id,
      status: 'queued',
      received_at: expect.any(String),
    });

    const job = await inspector.getJob(id);
    expect(job).toBeDefined();
    expect(job?.id).toBe(id);
    expect(job?.name).toBe('triage');
    expect(job?.data).toEqual({
      subject: 'Cannot log in',
      body: 'I forgot my password.',
      customer_id: 'cust-42',
      received_at: get.body.received_at,
    });
    expect(new Date(get.body.received_at).getTime()).toBeGreaterThanOrEqual(before - 1);
    // No worker runs in this file (see beforeAll), so the job must still be waiting.
    expect(await job?.getState()).toBe('waiting');
  });

  it('the default job options (retention) are applied', async () => {
    const post = await request(app.getHttpServer())
      .post('/tickets')
      .send({ subject: 'a', body: 'b' })
      .expect(202);
    created.push(post.body.job_id);

    const job = await inspector.getJob(post.body.job_id);
    expect(job?.opts.removeOnComplete).toEqual({ age: 86400 });
    expect(job?.opts.removeOnFail).toEqual({ age: 604800 });
    expect(job?.data).not.toHaveProperty('customer_id');
  });

  it('GET of an id that was never created -> 404', async () => {
    await request(app.getHttpServer())
      .get('/jobs/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d')
      .expect(404);
  });
});
