import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, vi } from 'vitest';
import { RATE_LIMIT_WINDOW_SECONDS } from '../src/auth/rate-limit.guard.js';
import { configureApp } from '../src/app.setup.js';
import { WorkerModule } from '../src/worker/worker.module.js';
import { NoWorkerModule, stubEnv } from './app-helpers.js';
import { api, stubAuthEnv } from './auth-helpers.js';

/**
 * The rate limit against a REAL Redis (the real Lua script), with RATE_LIMIT_PER_MINUTE=3 and a
 * 2-second window so the reset can be seen. Skipped unless REDIS_TEST_URL is set.
 * It only uses GET /jobs/:id, so nothing is queued. It deletes the counters it creates.
 */
const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
const LIMIT = 3;
const WINDOW_SECONDS = 2;
const MISSING = '00000000-0000-4000-8000-000000000000';

describe.skipIf(!REDIS_TEST_URL)('rate limit against a real Redis', () => {
  let app: NestExpressApplication;
  let redis: Redis;

  beforeAll(async () => {
    stubEnv(REDIS_TEST_URL);
    stubAuthEnv(String(LIMIT));
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideModule(WorkerModule)
      .useModule(NoWorkerModule)
      .overrideProvider(RATE_LIMIT_WINDOW_SECONDS)
      .useValue(WINDOW_SECONDS)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.init();
    redis = new Redis(REDIS_TEST_URL as string);
    await redis.del('rl:client:alice', 'rl:client:bob');
  });

  afterAll(async () => {
    await redis?.del('rl:client:alice', 'rl:client:bob');
    redis?.disconnect();
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('N requests are allowed, request N+1 is a 429 with Retry-After, and the window then resets', async () => {
    const remaining: string[] = [];
    for (let i = 0; i < LIMIT; i += 1) {
      const response = await api(app, 'alice').get(`/jobs/${MISSING}`).expect(404);
      expect(response.headers['ratelimit-limit']).toBe(String(LIMIT));
      remaining.push(response.headers['ratelimit-remaining']);
    }
    expect(remaining).toEqual(['2', '1', '0']);

    const over = await api(app, 'alice').get(`/jobs/${MISSING}`).expect(429);
    expect(over.body).toEqual({ detail: 'Rate limit exceeded' });
    expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(over.headers['retry-after'])).toBeLessThanOrEqual(WINDOW_SECONDS);
    expect(over.headers['ratelimit-remaining']).toBe('0');

    // The counter is a real Redis key with an expiry: it can never be counted forever.
    expect(await redis.ttl('rl:client:alice')).toBeGreaterThan(0);
    expect(await redis.ttl('rl:client:alice')).toBeLessThanOrEqual(WINDOW_SECONDS);

    await new Promise((resolve) => setTimeout(resolve, (WINDOW_SECONDS + 0.3) * 1000));
    const again = await api(app, 'alice').get(`/jobs/${MISSING}`).expect(404);
    expect(again.headers['ratelimit-remaining']).toBe(String(LIMIT - 1));
  });

  it('one client being limited does not limit another', async () => {
    for (let i = 0; i < LIMIT + 1; i += 1) await api(app, 'alice').get(`/jobs/${MISSING}`);
    const bob = await api(app, 'bob').get(`/jobs/${MISSING}`).expect(404);
    expect(bob.headers['ratelimit-remaining']).toBe(String(LIMIT - 1));
  });

  it('concurrent requests are counted exactly: 10 at once against a limit of 3 -> 3 allowed, 7 limited', async () => {
    await redis.del('rl:client:bob');
    const answers = await Promise.all(Array.from({ length: 10 }, () => api(app, 'bob').get(`/jobs/${MISSING}`)));
    const statuses = answers.map((a) => a.status);
    expect(statuses.filter((s) => s === 404)).toHaveLength(LIMIT);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10 - LIMIT);
  });
});
