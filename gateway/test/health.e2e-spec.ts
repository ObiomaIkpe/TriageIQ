import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { stubAuthEnv } from './auth-helpers.js';
import { FETCH, READY_TIMEOUT_MS } from '../src/health/health.constants.js';
import { PG_POOL } from '../src/database/database.constants.js';
import { REDIS_CLIENT } from '../src/redis/redis.constants.js';

type Fake = { ping: () => Promise<string>; status: string; quit: () => Promise<string>; disconnect: () => void };

function fakeRedis(ping: () => Promise<string>): Fake {
  return { ping, status: 'ready', quit: async () => 'OK', disconnect: () => undefined };
}

const okFetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
const downFetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;

const okPool = { query: async () => ({ rows: [] }), end: async () => undefined, on: () => undefined };

async function startApp(
  redis: Fake,
  fetchFn: typeof fetch,
  pool: unknown = okPool,
): Promise<INestApplication<App>> {
  // Loaded here so the environment is set first (the config is checked when the module loads).
  const { AppModule } = await import('../src/app.module.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REDIS_CLIENT)
    .useValue(redis)
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .overrideProvider(FETCH)
    .useValue(fetchFn)
    .overrideProvider(READY_TIMEOUT_MS)
    .useValue(200)
    .compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  await app.init();
  return app;
}

describe('health endpoints (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(() => {
    vi.stubEnv('PORT', '3000');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('TRIAGE_SERVICE_URL', 'http://localhost:8000');
    vi.stubEnv('GATEWAY_DATABASE_URL', 'postgresql://gateway:secret@localhost:5432/gateway_test');
    stubAuthEnv(); // the health routes are public: these requests carry no key
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('GET /health -> 200 {"status":"ok"} without touching any dependency (Postgres included)', async () => {
    const ping = vi.fn(async () => 'PONG');
    const query = vi.fn(async () => ({ rows: [] }));
    const fetchFn = vi.fn(okFetch) as unknown as typeof fetch;
    app = await startApp(fakeRedis(ping), fetchFn, { ...okPool, query });

    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toEqual({ status: 'ok' });
    expect(ping).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('GET /ready with both dependencies ok -> 200', async () => {
    app = await startApp(fakeRedis(async () => 'PONG'), okFetch);

    const response = await request(app.getHttpServer()).get('/ready').expect(200);

    expect(response.body).toEqual({ status: 'ready', checks: { redis: 'ok', triage: 'ok', postgres: 'ok' } });
  });

  it('GET /ready with Redis down -> 503', async () => {
    const down = fakeRedis(async () => {
      throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' });
    });
    app = await startApp(down, okFetch);

    const response = await request(app.getHttpServer()).get('/ready').expect(503);

    expect(response.body).toEqual({
      status: 'not_ready',
      checks: { redis: 'down', triage: 'ok', postgres: 'ok' },
      reasons: { redis: 'connection refused' },
    });
  });

  it('GET /ready with the Python service answering 503 -> 503', async () => {
    app = await startApp(fakeRedis(async () => 'PONG'), downFetch);

    const response = await request(app.getHttpServer()).get('/ready').expect(503);

    expect(response.body).toEqual({
      status: 'not_ready',
      checks: { redis: 'ok', triage: 'down', postgres: 'ok' },
      reasons: { triage: 'status 503' },
    });
  });

  it('GET /ready with Postgres down -> 503 naming it, with a fixed reason (no URL or password)', async () => {
    const down = {
      ...okPool,
      query: async () => {
        throw Object.assign(new Error('password authentication failed for user "gateway"'), { code: '28P01' });
      },
    };
    app = await startApp(fakeRedis(async () => 'PONG'), okFetch, down);

    const response = await request(app.getHttpServer()).get('/ready').expect(503);

    expect(response.body).toEqual({
      status: 'not_ready',
      checks: { redis: 'ok', triage: 'ok', postgres: 'down' },
      reasons: { postgres: 'authentication failed' },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/secret|gateway:|localhost/);
  });

  it('GET /health stays 200 even when Postgres is down', async () => {
    const down = { ...okPool, query: async () => Promise.reject(new Error('down')) };
    app = await startApp(fakeRedis(async () => 'PONG'), okFetch, down);
    await request(app.getHttpServer()).get('/health').expect(200);
  });
});
