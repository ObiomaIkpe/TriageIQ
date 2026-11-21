import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { vi } from 'vitest';
import { stubAuthEnv } from './auth-helpers.js';
import { FETCH, READY_TIMEOUT_MS } from '../src/health/health.constants.js';
import { REDIS_CLIENT } from '../src/redis/redis.constants.js';

type Fake = { ping: () => Promise<string>; status: string; quit: () => Promise<string>; disconnect: () => void };

function fakeRedis(ping: () => Promise<string>): Fake {
  return { ping, status: 'ready', quit: async () => 'OK', disconnect: () => undefined };
}

const okFetch = (async () => new Response(null, { status: 200 })) as unknown as typeof fetch;
const downFetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;

async function startApp(redis: Fake, fetchFn: typeof fetch): Promise<INestApplication<App>> {
  // Loaded here so the environment is set first (the config is checked when the module loads).
  const { AppModule } = await import('../src/app.module.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REDIS_CLIENT)
    .useValue(redis)
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
    stubAuthEnv(); // the health routes are public: these requests carry no key
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it('GET /health -> 200 {"status":"ok"} without touching any dependency', async () => {
    const ping = vi.fn(async () => 'PONG');
    const fetchFn = vi.fn(okFetch) as unknown as typeof fetch;
    app = await startApp(fakeRedis(ping), fetchFn);

    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toEqual({ status: 'ok' });
    expect(ping).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('GET /ready with both dependencies ok -> 200', async () => {
    app = await startApp(fakeRedis(async () => 'PONG'), okFetch);

    const response = await request(app.getHttpServer()).get('/ready').expect(200);

    expect(response.body).toEqual({ status: 'ready', checks: { redis: 'ok', triage: 'ok' } });
  });

  it('GET /ready with Redis down -> 503', async () => {
    const down = fakeRedis(async () => {
      throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' });
    });
    app = await startApp(down, okFetch);

    const response = await request(app.getHttpServer()).get('/ready').expect(503);

    expect(response.body).toEqual({
      status: 'not_ready',
      checks: { redis: 'down', triage: 'ok' },
      reasons: { redis: 'connection refused' },
    });
  });

  it('GET /ready with the Python service answering 503 -> 503', async () => {
    app = await startApp(fakeRedis(async () => 'PONG'), downFetch);

    const response = await request(app.getHttpServer()).get('/ready').expect(503);

    expect(response.body).toEqual({
      status: 'not_ready',
      checks: { redis: 'ok', triage: 'down' },
      reasons: { triage: 'status 503' },
    });
  });
});
