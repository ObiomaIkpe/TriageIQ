import { type IncomingHttpHeaders, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { TRIAGE_API_TIMEOUTS } from '../src/triage-api/triage-api.constants.js';
import { startAppWithFakeQueue, stubEnv } from './app-helpers.js';
import { TEST_KEYS, TEST_REVIEW_KEY, api, bearer } from './auth-helpers.js';
import { FakeQueue } from './fake-queue.js';

/**
 * The reviewer passthrough routes through the real HTTP stack, with a fake Python server that
 * records exactly what it receives and answers whatever the test tells it to.
 */
const ID = '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34';
const REF = 'TKT-AAAAAA';
const RECORD = { ticket_id: ID, reference: REF, status: 'pending_review', subject: 's', body: 'b' };

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

describe('reviewer routes forwarded to Python (fake Python server)', () => {
  let python: Server;
  let app: NestExpressApplication;
  const seen: Seen[] = [];
  /** What the fake Python answers next. */
  let answer: { status: number; body: unknown; hang?: boolean } = { status: 200, body: [] };

  beforeAll(async () => {
    python = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += String(chunk)));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        if (answer.hang) return;
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((resolve) => python.listen(0, '127.0.0.1', resolve));
    const { port } = python.address() as AddressInfo;

    stubEnv();
    vi.stubEnv('TRIAGE_SERVICE_URL', `http://127.0.0.1:${port}`);
    const queue = new FakeQueue();
    app = await startAppWithFakeQueue(queue);
    // The app module is built once, with the real 10 s and 30 s timeouts; shorten them here.
    const timeouts = app.get(TRIAGE_API_TIMEOUTS) as { readMs: number; reviewMs: number };
    timeouts.readMs = 300;
    timeouts.reviewMs = 600;
  });

  afterAll(async () => {
    await app?.close();
    python?.closeAllConnections();
    await new Promise((resolve) => python?.close(resolve));
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    seen.length = 0;
    answer = { status: 200, body: [] };
  });

  describe('each route forwards correctly', () => {
    it('GET /tickets -> Python GET /tickets, with only status and limit', async () => {
      answer = { status: 200, body: [RECORD] };
      const response = await api(app, 'ops').get('/tickets?status=pending_review&limit=5&evil=1&offset=9').expect(200);
      expect(response.body).toEqual([RECORD]);
      expect(seen).toHaveLength(1);
      expect(seen[0].method).toBe('GET');
      expect(seen[0].url).toBe('/tickets?status=pending_review&limit=5'); // evil and offset dropped
    });

    it('GET /tickets forwards a keyset cursor (and encodes it)', async () => {
      const cursor = `2026-11-23T10:00:00.123456+00:00|${ID}`;
      await api(app, 'ops').get('/tickets').query({ status: 'pending_review', limit: 20, cursor }).expect(200);
      expect(seen[0].url).toBe(`/tickets?status=pending_review&limit=20&cursor=${encodeURIComponent(cursor)}`);
    });

    it('GET /tickets/counts reaches the COUNTS route (not /tickets/:id) and returns the counts', async () => {
      const counts = { triaged: 4, pending_review: 2, approved: 1, edited: 0, rejected: 3 };
      answer = { status: 200, body: counts };
      const response = await api(app, 'ops').get('/tickets/counts').expect(200);
      expect(response.body).toEqual(counts);
      expect(seen.map((s) => s.url)).toEqual(['/tickets/counts']);
    });

    it('a submitter cannot read the counts (403) and Python is not contacted', async () => {
      await api(app, 'alice').get('/tickets/counts').expect(403);
      expect(seen).toHaveLength(0);
    });

    it.each([{ triaged: 1 }, [], { triaged: -1, pending_review: 0, approved: 0, edited: 0, rejected: 0 }, { triaged: 'x', pending_review: 0, approved: 0, edited: 0, rejected: 0 }])(
      'a malformed counts answer from Python is a 502',
      async (body) => {
        answer = { status: 200, body };
        await api(app, 'ops').get('/tickets/counts').expect(502);
      },
    );

    it('GET /tickets with no parameters sends none', async () => {
      await api(app, 'ops').get('/tickets').expect(200);
      expect(seen[0].url).toBe('/tickets');
    });

    it('GET /tickets/:id -> Python GET /tickets/{id}', async () => {
      answer = { status: 200, body: RECORD };
      const response = await api(app, 'ops').get(`/tickets/${ID}`).expect(200);
      expect(response.body).toEqual(RECORD);
      expect(seen.map((s) => s.url)).toEqual([`/tickets/${ID}`]);
    });

    it('GET /tickets/reference/TKT-AAAAAA reaches the REFERENCE route (not /tickets/:id)', async () => {
      answer = { status: 200, body: RECORD };
      await api(app, 'ops').get(`/tickets/reference/${REF}`).expect(200);
      expect(seen.map((s) => s.url)).toEqual([`/tickets/reference/${REF}`]);
    });

    it('POST /tickets/:id/review -> Python POST /tickets/{id}/review with the validated decision', async () => {
      answer = { status: 200, body: { ...RECORD, status: 'edited' } };
      const response = await api(app, 'ops')
        .post(`/tickets/${ID}/review`)
        .send({ action: 'edit', edited_reply: 'A human wrote this.', note: 'checked', extra: undefined })
        .expect(200);
      expect(response.body.status).toBe('edited');
      expect(seen[0].method).toBe('POST');
      expect(seen[0].url).toBe(`/tickets/${ID}/review`);
      expect(seen[0].headers['content-type']).toBe('application/json');
      // the client's validated decision, plus WHO is reviewing, taken from the authenticated key (client "ops")
      expect(JSON.parse(seen[0].body)).toEqual({
        action: 'edit',
        edited_reply: 'A human wrote this.',
        note: 'checked',
        reviewer: { id: 'client:ops', name: 'ops' },
      });
    });

    it('POST /tickets is still the intake route: it queues a ticket (202) and never reaches Python', async () => {
      const response = await api(app, 'ops').post('/tickets').send({ subject: 's', body: 'b' }).expect(202);
      expect(response.body.job_id).toBeDefined();
      expect(seen).toHaveLength(0);
    });
  });

  describe('credentials', () => {
    it('Python receives X-API-Key equal to the configured value and NOT the client Authorization header', async () => {
      await api(app, 'ops').get(`/tickets/${ID}`).expect(200);
      await api(app, 'ops').post(`/tickets/${ID}/review`).send({ action: 'approve' }).expect(200);
      expect(seen).toHaveLength(2);
      for (const call of seen) {
        expect(call.headers['x-api-key']).toBe(TEST_REVIEW_KEY);
        expect(call.headers.authorization).toBeUndefined();
        // nothing of the client's key appears anywhere in what Python received
        expect(JSON.stringify(call.headers)).not.toContain(TEST_KEYS.ops);
        expect(JSON.stringify(call.headers)).not.toContain('Bearer');
      }
    });

    it('other client headers are not forwarded either (cookies, custom headers, idempotency)', async () => {
      await request(app.getHttpServer())
        .get(`/tickets/${ID}`)
        .set('Authorization', bearer('ops'))
        .set('Cookie', 'session=abc')
        .set('X-Custom', 'yes')
        .set('Idempotency-Key', 'k')
        .set('X-Forwarded-For', '1.2.3.4')
        .expect(200);
      const headers = Object.keys(seen[0].headers).sort((a, b) => a.localeCompare(b));
      for (const forbidden of ['cookie', 'x-custom', 'idempotency-key', 'x-forwarded-for', 'authorization']) {
        expect(headers).not.toContain(forbidden);
      }
    });

    it('the review key never appears in any answer to the client', async () => {
      answer = { status: 401, body: { detail: 'Missing or invalid API key' } };
      const response = await api(app, 'ops').post(`/tickets/${ID}/review`).send({ action: 'approve' });
      expect(JSON.stringify(response.body) + JSON.stringify(response.headers)).not.toContain(TEST_REVIEW_KEY);
    });
  });

  describe('roles', () => {
    it.each([
      ['GET', '/tickets'],
      ['GET', `/tickets/${ID}`],
      ['GET', `/tickets/reference/${REF}`],
      ['POST', `/tickets/${ID}/review`],
    ])('a submitter gets 403 on %s %s, and Python is not contacted', async (method, path) => {
      const http = api(app, 'alice');
      const response = await (method === 'GET' ? http.get(path) : http.post(path).send({ action: 'approve' }));
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ detail: 'Not allowed' });
      expect(seen).toHaveLength(0);
    });

    it('no key -> 401 on every passthrough route', async () => {
      await request(app.getHttpServer()).get('/tickets').expect(401);
      await request(app.getHttpServer()).get(`/tickets/${ID}`).expect(401);
      await request(app.getHttpServer()).post(`/tickets/${ID}/review`).send({ action: 'approve' }).expect(401);
      expect(seen).toHaveLength(0);
    });
  });

  describe('Python statuses', () => {
    it.each([
      [200, [RECORD]],
      [400, { detail: 'bad request' }],
      [404, { detail: 'Ticket not found' }],
      [409, { detail: 'Ticket is not waiting for a review' }],
      [422, { detail: [{ type: 'x', msg: 'bad' }] }],
    ])('%i and its JSON body pass through', async (status, body) => {
      answer = { status, body };
      const response = await api(app, 'ops').get('/tickets');
      expect(response.status).toBe(status);
      expect(response.body).toEqual(body);
    });

    it('review: 404, 409 and 422 pass through too', async () => {
      for (const [status, body] of [
        [404, { detail: 'Ticket not found' }],
        [409, { detail: 'Ticket is not waiting for a review' }],
        [422, { detail: 'Cannot approve a ticket that has no draft reply; edit or reject it instead' }],
      ] as const) {
        answer = { status, body };
        const response = await api(app, 'ops').post(`/tickets/${ID}/review`).send({ action: 'approve' });
        expect(response.status).toBe(status);
        expect(response.body).toEqual(body);
      }
    });

    it.each([
      [401, { detail: 'Missing or invalid API key' }],
      [503, { detail: 'Review is disabled: REVIEW_API_KEY is not set' }],
    ])('Python %i from the review key check -> 502 "Triage service rejected the gateway"', async (status, body) => {
      answer = { status, body };
      const response = await api(app, 'ops').post(`/tickets/${ID}/review`).send({ action: 'approve' }).expect(502);
      expect(response.body).toEqual({ detail: 'Triage service rejected the gateway' });
    });

    it('Python 500 -> 502 "Triage service error", with no Python text', async () => {
      answer = { status: 500, body: { detail: 'Traceback (most recent call last): File "/app/x.py" postgresql://db:5432' } };
      const response = await api(app, 'ops').get('/tickets').expect(502);
      expect(response.body).toEqual({ detail: 'Triage service error' });
    });

    it('Python 503 for a database outage -> 503 "please retry"', async () => {
      answer = { status: 503, body: { detail: 'Database temporarily unavailable. Please retry.' } };
      const response = await api(app, 'ops').get('/tickets').expect(503);
      expect(response.body).toEqual({ detail: 'Triage service unavailable; please retry' });
    });

    it('a Python that never answers -> 503 within the timeout (reads), and for a review', async () => {
      answer = { status: 200, body: [], hang: true };
      const started = Date.now();
      const read = await api(app, 'ops').get('/tickets').expect(503);
      expect(read.body).toEqual({ detail: 'Triage service unavailable; please retry' });
      expect(Date.now() - started).toBeLessThan(2000);
      await api(app, 'ops').post(`/tickets/${ID}/review`).send({ action: 'approve' }).expect(503);
    });
  });

  describe('validation happens before Python is contacted', () => {
    it.each(['not-a-uuid', '123', 'TKT-AAAAAA'])('GET /tickets/%s -> 400', async (id) => {
      const response = await api(app, 'ops').get(`/tickets/${id}`).expect(400);
      expect(response.body).toEqual({ detail: 'Malformed ticket id' });
      expect(seen).toHaveLength(0);
    });

    it.each(['tkt-aaaaaa', 'TKT-AAAAA0', 'TKT-AAAAAAA', 'nonsense'])('GET /tickets/reference/%s -> 400', async (ref) => {
      const response = await api(app, 'ops').get(`/tickets/reference/${ref}`).expect(400);
      expect(response.body).toEqual({ detail: 'Malformed ticket reference' });
      expect(seen).toHaveLength(0);
    });

    it.each(['limit=0', 'limit=201', 'limit=abc', 'status=bogus', 'cursor=nonsense', 'cursor=2026-11-23T10:00:00Z', 'status=a&status=b'])('GET /tickets?%s -> 400', async (query) => {
      const response = await api(app, 'ops').get(`/tickets?${query}`).expect(400);
      expect(response.body.detail).toBe('Invalid query');
      expect(seen).toHaveLength(0);
    });

    it.each([
      [{}, 'action'],
      [{ action: 'delete' }, 'action'],
      [{ action: 'edit' }, 'edited_reply'],
      [{ action: 'edit', edited_reply: '  ' }, 'edited_reply'],
      [{ action: 'approve', surprise: 1 }, 'surprise'],
    ])('POST review with body %j -> 400 naming %s, value not echoed', async (body, field) => {
      const response = await api(app, 'ops').post(`/tickets/${ID}/review`).send(body).expect(400);
      expect(response.body.detail).toBe('Invalid review decision');
      expect(response.body.errors[0].field).toBe(field);
      expect(seen).toHaveLength(0);
    });

    it('POST review with a malformed id -> 400; with a non-JSON content type -> 415; none reach Python', async () => {
      await api(app, 'ops').post('/tickets/nope/review').send({ action: 'approve' }).expect(400);
      await request(app.getHttpServer())
        .post(`/tickets/${ID}/review`)
        .set('Authorization', bearer('ops'))
        .set('Content-Type', 'text/plain')
        .send('approve')
        .expect(415);
      expect(seen).toHaveLength(0);
    });
  });

  it('every passthrough answer carries the rate-limit headers and no X-Powered-By', async () => {
    const response = await api(app, 'ops').get('/tickets').expect(200);
    expect(response.headers['ratelimit-limit']).toBeDefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});
