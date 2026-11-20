import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, vi } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { stubEnv } from './app-helpers.js';

/**
 * The real BullMQ queue pointed at a port nothing listens on (needs no Redis).
 * Checks that intake answers 503 quickly instead of hanging, and never says 202.
 */
describe('ticket intake when Redis is unreachable', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    stubEnv('redis://127.0.0.1:1');
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('POST /tickets -> 503 within the timeout, with the retry message', async () => {
    const started = Date.now();
    const response = await request(app.getHttpServer())
      .post('/tickets')
      .send({ subject: 'a', body: 'b' })
      .expect(503);

    expect(Date.now() - started).toBeLessThan(3500);
    expect(response.body).toEqual({
      detail: 'Ticket intake is temporarily unavailable; please retry',
    });
    expect(response.headers.location).toBeUndefined();
  });

  it('GET /jobs/:id -> 503 within the timeout', async () => {
    const started = Date.now();
    await request(app.getHttpServer())
      .get('/jobs/9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d')
      .expect(503);
    expect(Date.now() - started).toBeLessThan(3500);
  });
});
