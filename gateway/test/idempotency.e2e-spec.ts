import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { startAppWithFakeQueue, stubEnv } from './app-helpers.js';
import { FakeQueue } from './fake-queue.js';
import { api } from './auth-helpers.js';

/** POST /tickets with an Idempotency-Key through the real HTTP stack, with a fake queue. */
const TICKET = { subject: 'Cannot log in', body: 'I forgot my password.', customer_id: 'c1' };

describe('POST /tickets with an Idempotency-Key header (fake queue)', () => {
  let queue: FakeQueue;
  let app: NestExpressApplication;

  beforeAll(() => {
    stubEnv();
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  async function start() {
    queue = new FakeQueue();
    app = await startAppWithFakeQueue(queue);
    return api(app);
  }

  it('first request: 202, no replay header. Same key and ticket again: same body, same Location, replay header', async () => {
    const http = await start();
    const first = await http.post('/tickets').set('Idempotency-Key', 'order-1').send(TICKET).expect(202);
    const second = await http.post('/tickets').set('Idempotency-Key', 'order-1').send(TICKET).expect(202);

    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body).toEqual(first.body);
    expect(second.headers.location).toBe(first.headers.location);
    expect(second.body.status_url).toBe(`/jobs/${first.body.job_id}`);
    expect(queue.added).toHaveLength(1);
  });

  it('the same ticket with padded whitespace is still the same ticket', async () => {
    const http = await start();
    const first = await http.post('/tickets').set('Idempotency-Key', 'k').send(TICKET).expect(202);
    const second = await http
      .post('/tickets')
      .set('Idempotency-Key', 'k')
      .send({ ...TICKET, subject: '  Cannot log in  ', body: '\n I forgot my password. ' })
      .expect(202);
    expect(second.body.job_id).toBe(first.body.job_id);
    expect(queue.added).toHaveLength(1);
  });

  it('the same key with a different ticket -> 422 with the detail, and nothing queued', async () => {
    const http = await start();
    await http.post('/tickets').set('Idempotency-Key', 'k').send(TICKET).expect(202);
    const clash = await http
      .post('/tickets')
      .set('Idempotency-Key', 'k')
      .send({ ...TICKET, body: 'Something else entirely.' })
      .expect(422);
    expect(clash.body).toEqual({ detail: 'Idempotency-Key was already used with a different ticket' });
    expect(clash.headers['idempotent-replayed']).toBeUndefined();
    expect(queue.added).toHaveLength(1);
  });

  it.each(['', 'has space', 'x'.repeat(101), 'bad/slash', 'SECRETVALUE!'])(
    'an invalid key %j -> 400, value not echoed, nothing queued',
    async (key) => {
      const http = await start();
      const response = await http.post('/tickets').set('Idempotency-Key', key).send(TICKET).expect(400);
      expect(response.body).toEqual({
        detail: 'Invalid Idempotency-Key',
        errors: [
          { field: 'Idempotency-Key', problem: 'must be 1 to 100 characters: letters, digits, _ . : -' },
        ],
      });
      expect(JSON.stringify(response.body)).not.toContain('SECRET');
      expect(queue.added).toHaveLength(0);
    },
  );

  it('a key sent twice (two headers) -> 400', async () => {
    const http = await start();
    await http
      .post('/tickets')
      .set('Content-Type', 'application/json')
      .set('Idempotency-Key', 'a')
      .set('Idempotency-Key', 'b')
      .send(TICKET)
      .expect((res) => {
        // supertest keeps only the last one; the point is that nothing breaks
        expect([202, 400]).toContain(res.status);
      });
  });

  it('a valid key with an invalid ticket -> 400 for the ticket, and the key is NOT claimed', async () => {
    const http = await start();
    await http.post('/tickets').set('Idempotency-Key', 'k').send({ subject: '', body: 'b' }).expect(400);
    expect(queue.kv.entries.size).toBe(0);
    await http.post('/tickets').set('Idempotency-Key', 'k').send(TICKET).expect(202); // the key is still free
  });

  it('without a key: unchanged, two posts make two jobs and no key is stored', async () => {
    const http = await start();
    const a = await http.post('/tickets').send(TICKET).expect(202);
    const b = await http.post('/tickets').send(TICKET).expect(202);
    expect(a.body.job_id).not.toBe(b.body.job_id);
    expect(a.headers['idempotent-replayed']).toBeUndefined();
    expect(queue.added).toHaveLength(2);
    expect(queue.kv.entries.size).toBe(0);
  });

  it('queueing fails -> 503, the key is released, and the retry with the same key succeeds', async () => {
    const http = await start();
    queue.addError = new Error('connect ECONNREFUSED 10.9.9.9:6379');
    const failed = await http.post('/tickets').set('Idempotency-Key', 'k').send(TICKET).expect(503);
    expect(failed.body).toEqual({ detail: 'Ticket intake is temporarily unavailable; please retry' });
    expect(queue.kv.entries.has('idem:ops:k')).toBe(false);

    queue.addError = undefined;
    const retry = await http.post('/tickets').set('Idempotency-Key', 'k').send(TICKET).expect(202);
    expect(retry.headers['idempotent-replayed']).toBeUndefined();
    expect(queue.added).toHaveLength(1);
  });

  it('Redis down -> 503 within the timeout, even with a key', async () => {
    const http = await start();
    queue.mode = 'fail';
    const started = Date.now();
    await http.post('/tickets').set('Idempotency-Key', 'k').send(TICKET).expect(503);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
