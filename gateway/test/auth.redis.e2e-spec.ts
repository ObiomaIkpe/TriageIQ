import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, vi } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { WorkerModule } from '../src/worker/worker.module.js';
import { NoWorkerModule, stubEnv } from './app-helpers.js';
import { api } from './auth-helpers.js';

/**
 * Two submitters and one reviewer against a REAL Redis: ownership end to end and per-client
 * idempotency. Skipped unless REDIS_TEST_URL is set (see tickets.redis.e2e-spec.ts). No worker
 * runs, so jobs stay in the queue. It removes the jobs and keys it creates.
 */
const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
const RUN = Math.random().toString(36).slice(2, 10);

describe.skipIf(!REDIS_TEST_URL)('API clients against a real Redis', () => {
  let app: NestExpressApplication;
  let inspector: Queue;
  let redis: Redis;
  const created: string[] = [];
  const keys: string[] = [];

  const ticket = (name: string) => ({ subject: `auth-${RUN}-${name}`, body: 'Please help' });

  beforeAll(async () => {
    stubEnv(REDIS_TEST_URL);
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideModule(WorkerModule)
      .useModule(NoWorkerModule)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.init();
    inspector = new Queue('triage', { connection: { url: REDIS_TEST_URL } });
    redis = new Redis(REDIS_TEST_URL as string);
  });

  afterAll(async () => {
    for (const id of created) await (await inspector?.getJob(id))?.remove().catch(() => undefined);
    if (redis && keys.length > 0) await redis.del(...keys);
    redis?.disconnect();
    await inspector?.close();
    await app?.close();
    vi.unstubAllEnvs();
  });

  async function submit(who: 'alice' | 'bob' | 'ops', name: string, key?: string) {
    const req = api(app, who).post('/tickets');
    if (key) req.set('Idempotency-Key', key);
    const response = await req.send(ticket(name));
    if (response.status === 202) created.push(response.body.job_id);
    return response;
  }

  it('no key -> 401; a wrong key -> 401; both without touching the queue', async () => {
    const none = await request(app.getHttpServer()).post('/tickets').send(ticket('nokey')).expect(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');
    await request(app.getHttpServer()).post('/tickets').set('Authorization', 'Bearer tiq_nope').send(ticket('nokey')).expect(401);
    const jobs = await inspector.getJobs(['waiting']);
    expect(jobs.some((job) => job.data.subject === ticket('nokey').subject)).toBe(false);
  });

  it('ownership end to end: the job in Redis carries the client; alice 200, bob 404, reviewer 200', async () => {
    const post = await submit('alice', 'owned').then((r) => {
      expect(r.status).toBe(202);
      return r;
    });
    const id = post.body.job_id as string;

    expect((await inspector.getJob(id))?.data.client).toBe('alice');
    await api(app, 'alice').get(`/jobs/${id}`).expect(200);
    const bob = await api(app, 'bob').get(`/jobs/${id}`).expect(404);
    expect(bob.body).toEqual({ detail: 'Job not found' });
    await api(app, 'ops').get(`/jobs/${id}`).expect(200);
  });

  it('a job stored without a client (as before M3.5a): 404 for a submitter, 200 for the reviewer', async () => {
    const id = randomUUID(); // gateway job ids are UUIDs
    await inspector.add('triage', { subject: `auth-${RUN}-old`, body: 'b', received_at: new Date().toISOString() }, { jobId: id });
    created.push(id);
    await api(app, 'alice').get(`/jobs/${id}`).expect(404);
    await api(app, 'ops').get(`/jobs/${id}`).expect(200);
  });

  it('roles: a submitter is 403 on the dead-letter routes, the reviewer is allowed', async () => {
    await api(app, 'alice').get('/dead-letters').expect(403);
    await api(app, 'bob').post('/dead-letters/00000000-0000-4000-8000-000000000000/retry').expect(403);
    await api(app, 'ops').get('/dead-letters?limit=1').expect(200);
  });

  it('idempotency: the same key from alice and bob -> two jobs; the same key twice from alice -> one', async () => {
    const key = `${RUN}-shared`;
    keys.push(`idem:alice:${key}`, `idem:bob:${key}`);
    const a1 = await submit('alice', 'idem', key);
    const b1 = await submit('bob', 'idem', key);
    const a2 = await submit('alice', 'idem', key);

    expect(a1.status).toBe(202);
    expect(b1.status).toBe(202);
    expect(b1.body.job_id).not.toBe(a1.body.job_id);
    expect(b1.headers['idempotent-replayed']).toBeUndefined();
    expect(a2.body.job_id).toBe(a1.body.job_id);
    expect(a2.headers['idempotent-replayed']).toBe('true');

    const stored = async (who: string) => JSON.parse((await redis.get(`idem:${who}:${key}`)) ?? 'null').job_id;
    expect(await stored('alice')).toBe(a1.body.job_id);
    expect(await stored('bob')).toBe(b1.body.job_id);
    const mine = (await inspector.getJobs(['waiting'])).filter((job) => job.data.subject === ticket('idem').subject);
    expect(mine).toHaveLength(2);
    expect(mine.map((job) => String(job.data.client)).sort((a, b) => a.localeCompare(b))).toEqual(['alice', 'bob']);
  });

  it('no response ever carries X-Powered-By', async () => {
    const responses = [
      await request(app.getHttpServer()).get('/health'),
      await request(app.getHttpServer()).get('/jobs/x'),
      await api(app, 'alice').get('/dead-letters'),
      await api(app, 'ops').get('/dead-letters'),
      await submit('alice', 'header'),
    ];
    for (const response of responses) expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
