import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, beforeAll, vi } from 'vitest';
import { startAppWithFakeQueue, stubEnv } from './app-helpers.js';
import { api } from './auth-helpers.js';
import { FakeQueue } from './fake-queue.js';

describe('security headers (helmet)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    stubEnv();
    app = await startAppWithFakeQueue(new FakeQueue());
  });
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });

  const MISSING = '00000000-0000-4000-8000-000000000000';

  it.each([
    ['200 /health', () => request(app.getHttpServer()).get('/health')],
    ['401 no key', () => request(app.getHttpServer()).get('/jobs/x')],
    ['404 job', () => api(app).get(`/jobs/${MISSING}`)],
    ['400 bad id', () => api(app).get('/jobs/nope')],
    ['202 ticket', () => api(app).post('/tickets').send({ subject: 's', body: 'b' })],
    ['415 wrong content type', () => api(app).post('/tickets')],
    ['400 invalid JSON', () => api(app).post('/tickets').set('Content-Type', 'application/json').send('{nope')],
    ['404 unknown route (with key)', () => api(app).get('/nothing')],
  ])('%s: no X-Powered-By, and helmet headers present', async (_label, send) => {
    const response = await send();
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['strict-transport-security']).toBeDefined();
    expect(response.headers['content-security-policy']).toBeDefined();
    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('a 413 (body too large) also carries them', async () => {
    const response = await api(app)
      .post('/tickets')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ subject: 's', body: 'x'.repeat(200_000) }));
    expect(response.status).toBe(413);
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('prints the full header set of a typical response (so it can be reviewed)', async () => {
    const response = await api(app).get(`/jobs/${MISSING}`);
    console.info('HEADERS ' + JSON.stringify(Object.keys(response.headers).sort()));
    console.info('HEADER-VALUES ' + JSON.stringify(response.headers));
  });
});
