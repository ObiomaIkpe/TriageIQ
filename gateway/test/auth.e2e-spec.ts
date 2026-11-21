import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { startAppWithFakeQueue, stubEnv } from './app-helpers.js';
import { api, bearer } from './auth-helpers.js';
import { FakeJob, FakeQueue } from './fake-queue.js';

/** Authentication, roles, job ownership and per-client idempotency through the real HTTP stack. */
const TICKET = { subject: 'Cannot log in', body: 'I forgot my password.' };
const OLD_JOB = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const MISSING = '00000000-0000-4000-8000-000000000000';

describe('API keys, roles and ownership (fake queue)', () => {
  let queue: FakeQueue;
  let app: NestExpressApplication;

  beforeAll(() => stubEnv());
  afterEach(async () => {
    await app?.close();
  });
  afterAll(() => vi.unstubAllEnvs());

  async function start() {
    queue = new FakeQueue();
    app = await startAppWithFakeQueue(queue);
  }

  describe('who gets in', () => {
    it('/health and /ready are public: no key needed', async () => {
      await start();
      await request(app.getHttpServer()).get('/health').expect(200);
      // /ready checks Redis and Python; with the fakes it answers (200 or 503), but never 401.
      const ready = await request(app.getHttpServer()).get('/ready');
      expect(ready.status).not.toBe(401);
      expect(ready.headers['ratelimit-limit']).toBeUndefined(); // public routes are not counted
    });

    it.each([
      ['POST', '/tickets'],
      ['GET', `/jobs/${MISSING}`],
      ['GET', '/dead-letters'],
      ['POST', `/dead-letters/${MISSING}/retry`],
    ])('%s %s with no key -> 401, fixed body, WWW-Authenticate', async (method, path) => {
      await start();
      const http = request(app.getHttpServer());
      const response = await (method === 'POST' ? http.post(path).send(TICKET) : http.get(path));
      expect(response.status).toBe(401);
      expect(response.body).toEqual({ detail: 'Missing or invalid API key' });
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(response.headers['ratelimit-limit']).toBeUndefined(); // a 401 is not counted
      expect(queue.added).toHaveLength(0);
    });

    it('a path that is not a route at all is a plain 404 (guards only run on real routes; nothing is revealed)', async () => {
      await start();
      const response = await request(app.getHttpServer()).get('/nothing-here').expect(404);
      expect(response.body).not.toHaveProperty('job_id');
      expect(response.headers['x-powered-by']).toBeUndefined();
    });

    it.each([
      ['an unknown key', 'Bearer tiq_unknown-key-0000'],
      ['the wrong scheme', 'Basic dGllcjp4'],
      ['a key with spaces', 'Bearer tiq a b'],
      ['an empty bearer', 'Bearer '],
    ])('%s -> 401, and the key is not echoed', async (_label, header) => {
      await start();
      const response = await request(app.getHttpServer()).post('/tickets').set('Authorization', header).send(TICKET).expect(401);
      expect(response.body).toEqual({ detail: 'Missing or invalid API key' });
      expect(response.headers['www-authenticate']).toBe('Bearer');
      expect(JSON.stringify(response.body) + JSON.stringify(response.headers)).not.toContain('unknown-key');
    });

    it('a 401 is returned even for a body that would be invalid (nothing is validated first)', async () => {
      await start();
      await request(app.getHttpServer()).post('/tickets').send({ junk: true }).expect(401);
    });
  });

  describe('roles', () => {
    it('a submitter may POST /tickets and read its own job', async () => {
      await start();
      const created = await api(app, 'alice').post('/tickets').send(TICKET).expect(202);
      await api(app, 'alice').get(created.body.status_url).expect(200);
    });

    it('a submitter gets 403 { detail: "Not allowed" } on both dead-letter routes', async () => {
      await start();
      for (const response of [
        await api(app, 'alice').get('/dead-letters'),
        await api(app, 'alice').post(`/dead-letters/${MISSING}/retry`),
      ]) {
        expect(response.status).toBe(403);
        expect(response.body).toEqual({ detail: 'Not allowed' });
      }
    });

    it('a reviewer may do everything a submitter can, plus the dead-letter routes', async () => {
      await start();
      await api(app, 'ops').post('/tickets').send(TICKET).expect(202);
      await api(app, 'ops').get('/dead-letters').expect(200);
      await api(app, 'ops').post(`/dead-letters/${MISSING}/retry`).expect(404); // allowed in; no such job
    });

    it('a 403 still carries the rate-limit headers (the request was authenticated and counted)', async () => {
      await start();
      const response = await api(app, 'alice').get('/dead-letters').expect(403);
      expect(response.headers['ratelimit-limit']).toBe('10000');
      expect(response.headers['ratelimit-remaining']).toBe('9999');
    });
  });

  describe('job ownership', () => {
    it('alice reads her job (200); bob gets 404 "Job not found"; the reviewer reads it too', async () => {
      await start();
      const created = await api(app, 'alice').post('/tickets').send(TICKET).expect(202);
      const url = created.body.status_url as string;

      await api(app, 'alice').get(url).expect(200);
      const bob = await api(app, 'bob').get(url).expect(404);
      expect(bob.body).toEqual({ detail: 'Job not found' });
      await api(app, 'ops').get(url).expect(200);
    });

    it("bob asking for alice's job and for a job that does not exist get the very same answer", async () => {
      await start();
      const created = await api(app, 'alice').post('/tickets').send(TICKET).expect(202);
      const foreign = await api(app, 'bob').get(created.body.status_url).expect(404);
      const missing = await api(app, 'bob').get(`/jobs/${MISSING}`).expect(404);
      expect(foreign.body).toEqual(missing.body);
    });

    it('a job from before API clients existed (no client): 404 for a submitter, 200 for the reviewer', async () => {
      await start();
      queue.jobs.set(OLD_JOB, new FakeJob({ subject: 's', body: 'b', received_at: '2026-11-01T00:00:00.000Z' }, 'waiting'));
      await api(app, 'alice').get(`/jobs/${OLD_JOB}`).expect(404);
      await api(app, 'ops').get(`/jobs/${OLD_JOB}`).expect(200);
    });

    it('the job stores the name of the client that submitted it', async () => {
      await start();
      await api(app, 'alice').post('/tickets').send(TICKET).expect(202);
      await api(app, 'bob').post('/tickets').send(TICKET).expect(202);
      expect(queue.added.map((job) => job.data.client)).toEqual(['alice', 'bob']);
    });

    it('dead-letter items show the client (null for an old job)', async () => {
      await start();
      const mine = new FakeJob({ subject: 's', body: 'b', received_at: 'r', client: 'alice' }, 'failed');
      mine.finishedOn = 2000;
      const old = new FakeJob({ subject: 's', body: 'b', received_at: 'r' }, 'failed');
      old.finishedOn = 1000;
      queue.jobs.set('00000000-0000-4000-8000-000000000001', mine);
      queue.jobs.set('00000000-0000-4000-8000-000000000002', old);
      const body = (await api(app, 'ops').get('/dead-letters').expect(200)).body;
      expect(body.items.map((item: { client: string | null }) => item.client)).toEqual(['alice', null]);
    });
  });

  describe('per-client idempotency', () => {
    const send = (who: 'alice' | 'bob', key: string, body = TICKET) =>
      api(app, who).post('/tickets').set('Idempotency-Key', key).send(body);

    it('the same Idempotency-Key from two clients makes two jobs', async () => {
      await start();
      const a = await send('alice', 'order-1').expect(202);
      const b = await send('bob', 'order-1').expect(202);
      expect(a.body.job_id).not.toBe(b.body.job_id);
      expect(b.headers['idempotent-replayed']).toBeUndefined();
      expect(queue.added).toHaveLength(2);
      expect([...queue.kv.entries.keys()].sort()).toEqual(['idem:alice:order-1', 'idem:bob:order-1']);
    });

    it('the same key from the same client is one job', async () => {
      await start();
      const first = await send('alice', 'order-1').expect(202);
      const second = await send('alice', 'order-1').expect(202);
      expect(second.body.job_id).toBe(first.body.job_id);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(queue.added).toHaveLength(1);
    });

    it('another client reusing a key with a different ticket is NOT a 422 (it is a different key)', async () => {
      await start();
      await send('alice', 'k').expect(202);
      await send('bob', 'k', { subject: 'other', body: 'another ticket' }).expect(202);
      expect(queue.added).toHaveLength(2);
    });
  });

  it('Authorization is never logged or echoed: a bad key does not appear in any response header', async () => {
    await start();
    const response = await request(app.getHttpServer())
      .get('/jobs/x')
      .set('Authorization', bearer('alice').replace('alice', 'alicX'))
      .expect(401);
    expect(JSON.stringify(response.headers)).not.toContain('alicX');
  });
});
