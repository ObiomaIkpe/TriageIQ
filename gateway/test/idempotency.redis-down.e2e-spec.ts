import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, vi } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { stubEnv } from './app-helpers.js';

/** The real queue and the real idempotency connection, pointed at a port nothing listens on. */
describe('POST /tickets with an Idempotency-Key when Redis is unreachable', () => {
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

  it('503 within the timeout, with the intake message, no Location, no replay header', async () => {
    const started = Date.now();
    const response = await request(app.getHttpServer())
      .post('/tickets')
      .set('Idempotency-Key', 'down-1')
      .send({ subject: 'a', body: 'b' })
      .expect(503);

    expect(Date.now() - started).toBeLessThan(3500);
    expect(response.body).toEqual({
      detail: 'Ticket intake is temporarily unavailable; please retry',
    });
    expect(response.headers.location).toBeUndefined();
    expect(response.headers['idempotent-replayed']).toBeUndefined();
  });
});
