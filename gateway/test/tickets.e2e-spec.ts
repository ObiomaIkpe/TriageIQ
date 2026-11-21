import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { startAppWithFakeQueue, stubEnv } from './app-helpers.js';
import { FakeJob, FakeQueue } from './fake-queue.js';
import { api } from './auth-helpers.js';

const SECRET = 'SECRETVALUE123';
const TICKET = { subject: 'Cannot log in', body: 'I forgot my password.', customer_id: 'cust-42' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KNOWN_ID = '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34';
const OTHER_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

describe('ticket intake and job status (e2e, fake queue)', () => {
  let app: NestExpressApplication;
  let queue: FakeQueue;

  beforeAll(() => stubEnv());
  afterAll(() => vi.unstubAllEnvs());

  beforeEach(async () => {
    queue = new FakeQueue();
    app = await startAppWithFakeQueue(queue, 150);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /tickets', () => {
    it('valid ticket -> 202 with job id, status_url and a Location header', async () => {
      const response = await api(app).post('/tickets').send(TICKET).expect(202);

      expect(response.body).toEqual({
        job_id: expect.stringMatching(UUID),
        status: 'queued',
        status_url: `/jobs/${response.body.job_id}`,
      });
      expect(response.headers.location).toBe(response.body.status_url);
      expect(queue.added).toHaveLength(1);
      expect(queue.added[0].jobId).toBe(response.body.job_id);
      expect(queue.added[0].data).toMatchObject(TICKET);
    });

    it('accepts a charset on the content type', async () => {
      await api(app)
        .post('/tickets')
        .set('Content-Type', 'application/json; charset=utf-8')
        .send(JSON.stringify(TICKET))
        .expect(202);
    });

    it('invalid ticket -> 400 with field/problem entries, values not echoed', async () => {
      const response = await api(app)
        .post('/tickets')
        .send({ subject: '', body: SECRET.repeat(500), extra: SECRET })
        .expect(400);

      expect(response.body).toEqual({
        detail: 'Invalid ticket',
        errors: expect.arrayContaining([
          { field: 'subject', problem: 'must not be empty' },
          { field: 'body', problem: 'must be at most 5000 characters' },
          { field: 'extra', problem: 'unknown field' },
        ]),
      });
      expect(JSON.stringify(response.body)).not.toContain(SECRET);
      expect(queue.added).toHaveLength(0);
    });

    it('malformed JSON -> 400 JSON error that does not quote the input', async () => {
      const response = await api(app)
        .post('/tickets')
        .set('Content-Type', 'application/json')
        .send(`{"subject": "${SECRET}", oops`)
        .expect(400);

      expect(response.body).toEqual({ detail: 'Request body is not valid JSON' });
      expect(JSON.stringify(response.body)).not.toContain(SECRET);
    });

    it('empty JSON body -> 400 listing the required fields', async () => {
      const response = await api(app)
        .post('/tickets')
        .set('Content-Type', 'application/json')
        .send('{}')
        .expect(400);
      expect(response.body.errors).toEqual([
        { field: 'subject', problem: 'is required' },
        { field: 'body', problem: 'is required' },
      ]);
    });

    it.each([
      ['text/plain', 'subject=x'],
      ['application/x-www-form-urlencoded', 'subject=x&body=y'],
      ['application/xml', '<ticket/>'],
    ])('content type %s -> 415', async (type, payload) => {
      const response = await api(app)
        .post('/tickets')
        .set('Content-Type', type)
        .send(payload)
        .expect(415);
      expect(response.body).toEqual({ detail: 'Content-Type must be application/json' });
      expect(queue.added).toHaveLength(0);
    });

    it('no content type -> 415', async () => {
      await api(app).post('/tickets').expect(415);
    });

    it('JSON body over 100 kb -> 413 before anything is queued', async () => {
      const big = JSON.stringify({ subject: 'x', body: 'y'.repeat(150 * 1024) });
      const response = await api(app)
        .post('/tickets')
        .set('Content-Type', 'application/json')
        .send(big)
        .expect(413);

      expect(response.body).toEqual({ detail: 'Request body too large (limit 100 kb)' });
      expect(queue.added).toHaveLength(0);
    });

    it('a body just under the limit gets as far as validation (400 for length, not 413)', async () => {
      const response = await api(app)
        .post('/tickets')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ subject: 'x', body: 'y'.repeat(90 * 1024) }))
        .expect(400);
      expect(response.body.errors).toEqual([
        { field: 'body', problem: 'must be at most 5000 characters' },
      ]);
    });

    it('queue failing -> 503, nothing stored', async () => {
      // The write fails; Redis itself answers (the rate limiter would otherwise be the first 503).
      queue.addError = new Error('connect ECONNREFUSED 10.9.9.9:6379');
      const response = await api(app).post('/tickets').send(TICKET).expect(503);
      expect(response.body).toEqual({
        detail: 'Ticket intake is temporarily unavailable; please retry',
      });
      expect(response.headers.location).toBeUndefined();
      expect(queue.added).toHaveLength(0);
    });

    it('queue hanging -> 503 within about the timeout, never a hang', async () => {
      queue.mode = 'hang';
      const started = Date.now();
      await api(app).post('/tickets').send(TICKET).expect(503);
      expect(Date.now() - started).toBeLessThan(1500);
    });
  });

  describe('GET /jobs/:id', () => {
    it('known queued job -> 200 queued', async () => {
      queue.jobs.set(
        KNOWN_ID,
        new FakeJob({ subject: 's', body: 'b', received_at: '2026-11-20T10:00:00.000Z' }),
      );
      const response = await api(app).get(`/jobs/${KNOWN_ID}`).expect(200);
      expect(response.body).toEqual({
        job_id: KNOWN_ID,
        status: 'queued',
        received_at: '2026-11-20T10:00:00.000Z',
      });
    });

    it('a job just created through POST can be read back', async () => {
      const created = await api(app).post('/tickets').send(TICKET).expect(202);
      const response = await api(app).get(created.body.status_url).expect(200);
      expect(response.body).toMatchObject({ job_id: created.body.job_id, status: 'queued' });
    });

    it('unknown id -> 404', async () => {
      const response = await api(app).get(`/jobs/${OTHER_ID}`).expect(404);
      expect(response.body).toEqual({ detail: 'Job not found' });
    });

    it('malformed id -> 400, not echoed', async () => {
      const response = await api(app).get(`/jobs/${SECRET}`).expect(400);
      expect(response.body).toEqual({ detail: 'Malformed job id' });
      expect(JSON.stringify(response.body)).not.toContain(SECRET);
    });

    it('queue failing -> 503', async () => {
      queue.mode = 'fail';
      await api(app).get(`/jobs/${KNOWN_ID}`).expect(503);
    });

    it('queue hanging -> 503 within about the timeout', async () => {
      queue.mode = 'hang';
      const started = Date.now();
      await api(app).get(`/jobs/${KNOWN_ID}`).expect(503);
      expect(Date.now() - started).toBeLessThan(1500);
    });
  });

  it('existing endpoints still work next to the new ones', async () => {
    await api(app).get('/health').expect(200);
  });
});
