import { getQueueToken } from '@nestjs/bullmq';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, vi } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { WorkerModule } from '../src/worker/worker.module.js';
import { NoWorkerModule, stubEnv } from './app-helpers.js';
import { api } from './auth-helpers.js';

/**
 * Idempotency-Key against a REAL Redis (real SET NX EX, the real Lua compare-and-delete).
 * Skipped unless REDIS_TEST_URL is set, e.g.
 *   docker run --rm -d --name gw-redis-test -p 6390:6379 redis:8.10.3-alpine
 *   REDIS_TEST_URL=redis://localhost:6390 npm run test:e2e
 * No worker runs, so jobs stay in the queue where the test can count them. It removes the
 * jobs and keys it creates and never flushes the database.
 */
const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
const RUN = Math.random().toString(36).slice(2, 10);

describe.skipIf(!REDIS_TEST_URL)('Idempotency-Key against a real Redis', () => {
  let app: NestExpressApplication;
  let inspector: Queue;
  let appQueue: Queue;
  let redis: Redis;
  const keys: string[] = [];
  const subjects: string[] = [];

  const newKey = (name: string) => {
    const key = `${RUN}-${name}`;
    keys.push(`idem:ops:${key}`);
    return key;
  };
  const ticket = (name: string) => {
    const subject = `idem-${RUN}-${name}`;
    subjects.push(subject);
    return { subject, body: 'Please help', customer_id: 'cust-1' };
  };
  const jobsFor = async (subject: string) =>
    (await inspector.getJobs(['waiting', 'active', 'delayed', 'completed', 'failed'])).filter(
      (job) => job.data.subject === subject,
    );

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
    appQueue = app.get<Queue>(getQueueToken('triage'));
    inspector = new Queue('triage', { connection: { url: REDIS_TEST_URL } });
    redis = new Redis(REDIS_TEST_URL as string); // a separate connection, to look at the keys
  });

  afterAll(async () => {
    for (const subject of subjects) {
      for (const job of await jobsFor(subject)) await job.remove().catch(() => undefined);
    }
    if (redis && keys.length > 0) await redis.del(...keys);
    redis?.disconnect();
    await inspector?.close();
    await app?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const post = (key: string | undefined, body: object) => {
    const req = api(app).post('/tickets');
    if (key !== undefined) req.set('Idempotency-Key', key);
    return req.send(body);
  };

  it('same key and same ticket twice: the same job id and ONE job in the queue', async () => {
    const key = newKey('twice');
    const t = ticket('twice');
    const first = await post(key, t).expect(202);
    const second = await post(key, t).expect(202);

    expect(second.body.job_id).toBe(first.body.job_id);
    expect(second.headers.location).toBe(first.headers.location);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(await jobsFor(t.subject)).toHaveLength(1);

    // What is stored: the job id and the fingerprint, expiring in about 24 hours.
    const stored = JSON.parse((await redis.get(`idem:ops:${key}`)) ?? 'null') as Record<string, string>;
    expect(stored.job_id).toBe(first.body.job_id);
    expect(stored.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const ttl = await redis.ttl(`idem:ops:${key}`);
    expect(ttl).toBeGreaterThan(86_400 - 30);
    expect(ttl).toBeLessThanOrEqual(86_400);
  });

  it('same key with a different ticket -> 422, and still one job', async () => {
    const key = newKey('clash');
    const t = ticket('clash');
    await post(key, t).expect(202);
    const other = { ...t, body: 'Different text' };
    const clash = await post(key, other).expect(422);
    expect(clash.body).toEqual({ detail: 'Idempotency-Key was already used with a different ticket' });
    expect(await jobsFor(t.subject)).toHaveLength(1);
  });

  it('five concurrent requests with one key: one job, and all five get the same job id', async () => {
    const key = newKey('five');
    const t = ticket('five');
    const answers = await Promise.all(Array.from({ length: 5 }, () => post(key, t)));

    expect(answers.map((a) => a.status)).toEqual([202, 202, 202, 202, 202]);
    expect(new Set(answers.map((a) => a.body.job_id)).size).toBe(1);
    expect(answers.filter((a) => a.headers['idempotent-replayed'] === 'true')).toHaveLength(4);
    expect(await jobsFor(t.subject)).toHaveLength(1);
  });

  it('enqueue failure: 503, the key is released (real Lua script), and a retry with the same key works', async () => {
    const key = newKey('fail');
    const t = ticket('fail');
    vi.spyOn(appQueue, 'add').mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.9.9.9:6379'));

    await post(key, t).expect(503);
    expect(await redis.get(`idem:ops:${key}`)).toBeNull(); // released
    expect(await jobsFor(t.subject)).toHaveLength(0);

    const retry = await post(key, t).expect(202);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(await jobsFor(t.subject)).toHaveLength(1);
  });

  it('the compare-and-delete leaves a key that holds a different job id alone', async () => {
    const key = newKey('cad');
    const t = ticket('cad');
    vi.spyOn(appQueue, 'add').mockImplementationOnce(async () => {
      // Another request claims the key while this one is failing.
        await redis.set(`idem:ops:${key}`, JSON.stringify({ job_id: 'someone-elses-job', fingerprint: 'f' }), 'EX', 60);
      throw new Error('boom');
    });
    await post(key, t).expect(503);
    expect(JSON.parse((await redis.get(`idem:ops:${key}`)) ?? 'null').job_id).toBe('someone-elses-job');
  });

  it('no key: two POSTs make two jobs, and nothing is stored under idem:', async () => {
    const t = ticket('nokey');
    const a = await post(undefined, t).expect(202);
    const b = await post(undefined, t).expect(202);
    expect(a.body.job_id).not.toBe(b.body.job_id);
    expect(a.headers['idempotent-replayed']).toBeUndefined();
    expect(await jobsFor(t.subject)).toHaveLength(2);
  });

  it('an invalid key -> 400 and nothing is stored', async () => {
    const t = ticket('badkey');
    const response = await post('bad key!', t).expect(400);
    expect(response.body.detail).toBe('Invalid Idempotency-Key');
    expect(await jobsFor(t.subject)).toHaveLength(0);
  });
});
