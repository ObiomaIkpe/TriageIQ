import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { startAppWithFakeQueue, stubEnv } from './app-helpers.js';
import { stubAuthEnv, api } from './auth-helpers.js';
import { FakeQueue } from './fake-queue.js';

/** The per-client rate limit with a small limit (3 a minute), through the real HTTP stack. */
const LIMIT = 3;
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('rate limit (fake queue, RATE_LIMIT_PER_MINUTE=3)', () => {
  let queue: FakeQueue;
  let app: NestExpressApplication;

  beforeAll(() => {
    stubEnv();
    stubAuthEnv(String(LIMIT)); // overrides the high limit the shared helper sets
  });
  afterEach(async () => {
    await app?.close();
  });
  afterAll(() => vi.unstubAllEnvs());

  async function start() {
    queue = new FakeQueue();
    app = await startAppWithFakeQueue(queue);
  }

  it('every authenticated response shows RateLimit-Limit and a falling RateLimit-Remaining', async () => {
    await start();
    const remaining: string[] = [];
    for (let i = 0; i < LIMIT; i += 1) {
      const response = await api(app, 'alice').get(`/jobs/${MISSING}`); // a 404 is still counted and labelled
      expect(response.headers['ratelimit-limit']).toBe('3');
      remaining.push(response.headers['ratelimit-remaining']);
    }
    expect(remaining).toEqual(['2', '1', '0']);
  });

  it('request N+1 -> 429 { detail: "Rate limit exceeded" } with Retry-After', async () => {
    await start();
    for (let i = 0; i < LIMIT; i += 1) await api(app, 'alice').get(`/jobs/${MISSING}`).expect(404);
    const over = await api(app, 'alice').get(`/jobs/${MISSING}`).expect(429);
    expect(over.body).toEqual({ detail: 'Rate limit exceeded' });
    expect(Number(over.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(over.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(over.headers['ratelimit-remaining']).toBe('0');
    expect(over.headers['ratelimit-limit']).toBe('3');
  });

  it('a limited request never reaches the route (POST /tickets over the limit queues nothing)', async () => {
    await start();
    for (let i = 0; i < LIMIT; i += 1) await api(app, 'alice').post('/tickets').send({ subject: 's', body: 'b' }).expect(202);
    await api(app, 'alice').post('/tickets').send({ subject: 's', body: 'b' }).expect(429);
    expect(queue.added).toHaveLength(LIMIT);
  });

  it('the limit is per client: alice being limited does not limit bob', async () => {
    await start();
    for (let i = 0; i < LIMIT + 1; i += 1) await api(app, 'alice').get(`/jobs/${MISSING}`);
    await api(app, 'alice').get(`/jobs/${MISSING}`).expect(429);
    const bob = await api(app, 'bob').get(`/jobs/${MISSING}`).expect(404);
    expect(bob.headers['ratelimit-remaining']).toBe('2');
  });

  it('the window resets: after it ends the client has its full limit again', async () => {
    await start();
    let now = 10_000_000;
    queue.kv.now = () => now;
    for (let i = 0; i < LIMIT; i += 1) await api(app, 'alice').get(`/jobs/${MISSING}`).expect(404);
    await api(app, 'alice').get(`/jobs/${MISSING}`).expect(429);
    now += 61_000;
    const again = await api(app, 'alice').get(`/jobs/${MISSING}`).expect(404);
    expect(again.headers['ratelimit-remaining']).toBe('2');
  });

  it('public routes are not counted, and unauthenticated requests are 401 before counting', async () => {
    await start();
    for (let i = 0; i < 10; i += 1) await request(app.getHttpServer()).get('/health').expect(200);
    for (let i = 0; i < 10; i += 1) await request(app.getHttpServer()).get(`/jobs/${MISSING}`).expect(401);
    const first = await api(app, 'alice').get(`/jobs/${MISSING}`).expect(404);
    expect(first.headers['ratelimit-remaining']).toBe('2'); // nothing above used up alice's allowance
    expect(queue.kv.counters.size).toBe(1);
  });

  it('Redis unreachable for the limiter -> 503 within the timeout', async () => {
    await start();
    queue.kv.limiterDown = true;
    const started = Date.now();
    const response = await api(app, 'alice').get(`/jobs/${MISSING}`).expect(503);
    expect(response.body).toEqual({ detail: 'Rate limiting is temporarily unavailable; please retry' });
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
