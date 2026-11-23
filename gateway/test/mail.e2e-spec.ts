import { getQueueToken } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterEach, beforeEach, vi } from 'vitest';
import { FETCH } from '../src/health/health.constants.js';
import { REPLY_QUEUE } from '../src/mail/mail.constants.js';
import { ReplyDeliveryRepository } from '../src/mail/reply-delivery.repository.js';
import { QueueUnavailableError } from '../src/queue/with-timeout.js';
import { startAppWithFakeQueue, stubEnv } from './app-helpers.js';
import { api, stubAuthEnv } from './auth-helpers.js';
import { FakeQueue } from './fake-queue.js';
import { FakeReplyQueue, MemoryDeliveries } from './mail-fakes.js';

/**
 * Reply email through the real app (routes, guards, validation): a review triggers a delivery, the delivery routes show and retry it.
 * Python is a fake (an in-process fetch); the delivery table and the reply queue are in memory.
 */
const ID = '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34';
const OTHER = '00000000-0000-4000-8000-000000000002';
const TICKET = { ticket_id: ID, reference: 'TKT-ABC234', status: 'approved', subject: 's', final_reply: 'r', customer_email: 'ada@example.com', reviewed_by: { id: 'client:ops', name: 'ops' } };

describe('reply email routes (fake Python, in-memory delivery table)', () => {
  let app: NestExpressApplication;
  let deliveries: MemoryDeliveries;
  let replyQueue: FakeReplyQueue;
  let python: { status: number; body: unknown };
  let calls: { method: string; url: string }[];
  let lines: string[];

  async function start(mailEnabled = true) {
    stubEnv();
    stubAuthEnv();
    const { validateEnv } = await import('../src/config/env.schema.js');
    const env = { ...process.env, MAIL_ENABLED: String(mailEnabled), SMTP_HOST: 'mailpit', SMTP_PORT: '1025', MAIL_FROM: 'support@triageiq.local' };
    const typed = validateEnv(env) as unknown as Record<string, unknown>;
    deliveries = new MemoryDeliveries();
    replyQueue = new FakeReplyQueue();
    calls = [];
    python = { status: 200, body: TICKET };
    const fetchFn = (async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url) });
      return new Response(JSON.stringify(python.body), { status: python.status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    app = await startAppWithFakeQueue(new FakeQueue(), 100, (b) =>
      b
        .overrideProvider(ConfigService).useValue({ get: (k: string) => typed[k], getOrThrow: (k: string) => typed[k] })
        .overrideProvider(ReplyDeliveryRepository).useValue(deliveries)
        .overrideProvider(getQueueToken(REPLY_QUEUE)).useValue(replyQueue)
        .overrideProvider(FETCH).useValue(fetchFn),
    );
  }
  const review = (body: object = { action: 'approve' }, id = ID, who: 'ops' | 'alice' = 'ops') => api(app, who).post(`/tickets/${id}/review`).send(body);

  beforeEach(() => {
    lines = [];
    for (const m of ['log', 'warn', 'error', 'debug', 'verbose'] as const) vi.spyOn(Logger.prototype, m).mockImplementation((msg: unknown) => void lines.push(String(msg)));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await app?.close();
  });

  describe('the review route triggers the delivery', () => {
    beforeEach(() => start());

    it.each(['approve', 'edit'])('%s -> 200 as before, and ONE queued delivery with ONE job', async (action) => {
      python.body = { ...TICKET, status: action === 'approve' ? 'approved' : 'edited' };
      const response = await review(action === 'edit' ? { action, edited_reply: 'mine' } : { action }).expect(200);
      expect(response.body.ticket_id).toBe(ID);
      expect(deliveries.rows.get(ID)?.status).toBe('queued');
      expect(replyQueue.adds).toEqual([{ name: 'send', jobId: ID }]);
    });

    it('reject -> nothing is queued (the human-approval rule)', async () => {
      python.body = { ...TICKET, status: 'rejected', final_reply: null };
      await review({ action: 'reject' }).expect(200);
      expect(deliveries.rows.size).toBe(0);
      expect(replyQueue.adds).toEqual([]);
    });

    it('a ticket with no customer email -> skipped_no_email, no job', async () => {
      python.body = { ...TICKET, customer_email: null };
      await review().expect(200);
      expect(deliveries.rows.get(ID)?.status).toBe('skipped_no_email');
      expect(replyQueue.adds).toEqual([]);
    });

    it('a Python error (409 already reviewed) queues nothing', async () => {
      python = { status: 409, body: { detail: 'Ticket is not waiting for a review' } };
      await review().expect(409);
      expect(replyQueue.adds).toEqual([]);
      expect(deliveries.rows.size).toBe(0);
    });

    it('the same ticket reviewed again (a retry, a double click) still makes only one job', async () => {
      await review().expect(200);
      await review().expect(200);
      expect(replyQueue.adds).toHaveLength(1);
    });

    it('if recording the delivery fails the review still succeeds, the failure is logged loudly (no address), and the sweep can repair it', async () => {
      deliveries.down = true;
      const response = await review().expect(200);
      expect(response.body.ticket_id).toBe(ID);
      const log = lines.join('\n');
      expect(log).toContain('Could not queue the reply email for TKT-ABC234');
      expect(log).not.toContain('ada@example.com');
      deliveries.down = false;
      expect(deliveries.rows.size).toBe(0); // nothing recorded: the sweep (which looks for approvals without a row) will do it
    });

    it('if the queue is down the review succeeds and no row is left behind', async () => {
      replyQueue.addError = new Error('redis down');
      await review().expect(200);
      expect(deliveries.rows.size).toBe(0);
    });

    it('a triaged-ticket approval (Python answers approved) is handled like any approval', async () => {
      python.body = { ...TICKET, status: 'approved', review_note: 'one click' };
      await review({ action: 'approve', note: 'one click' }).expect(200);
      expect(replyQueue.adds).toHaveLength(1);
      expect(calls.at(-1)).toMatchObject({ method: 'POST' });
    });
  });

  describe('with mail switched off', () => {
    it('reviews work and nothing is recorded or queued', async () => {
      await start(false);
      await review().expect(200);
      expect(deliveries.rows.size).toBe(0);
      expect(replyQueue.adds).toEqual([]);
    });
  });

  describe('GET /tickets/:id/delivery and POST /tickets/:id/delivery/retry', () => {
    beforeEach(() => start());

    it('none for a ticket with no delivery', async () => {
      const response = await api(app, 'ops').get(`/tickets/${OTHER}/delivery`).expect(200);
      expect(response.body).toEqual({ status: 'none', attempts: 0, sent_at: null, error: null });
      expect(calls).toEqual([]); // answered from the delivery table: Python is not asked
    });

    it('shows queued, sent (with the time), failed (with the short reason) and skipped_no_email', async () => {
      await review().expect(200);
      expect((await api(app, 'ops').get(`/tickets/${ID}/delivery`).expect(200)).body).toMatchObject({ status: 'queued', attempts: 0 });
      Object.assign(deliveries.rows.get(ID)!, { status: 'sent', attempts: 2, sent_at: new Date('2026-11-23T10:00:00Z') });
      expect((await api(app, 'ops').get(`/tickets/${ID}/delivery`)).body).toEqual({ status: 'sent', attempts: 2, sent_at: '2026-11-23T10:00:00.000Z', error: null });
      Object.assign(deliveries.rows.get(ID)!, { status: 'failed', sent_at: null, last_error: 'mail server unreachable' });
      expect((await api(app, 'ops').get(`/tickets/${ID}/delivery`)).body).toMatchObject({ status: 'failed', error: 'mail server unreachable' });
      deliveries.rows.get(ID)!.status = 'skipped_no_email';
      expect((await api(app, 'ops').get(`/tickets/${ID}/delivery`)).body.status).toBe('skipped_no_email');
    });

    it('retry of a failed delivery: back to queued, a new job, 200', async () => {
      await review().expect(200);
      Object.assign(deliveries.rows.get(ID)!, { status: 'failed', attempts: 8, last_error: 'mail server unreachable' });
      const response = await api(app, 'ops').post(`/tickets/${ID}/delivery/retry`).expect(201);
      expect(response.body).toMatchObject({ status: 'queued', attempts: 0, error: null });
      expect(replyQueue.adds).toHaveLength(2);
    });

    it.each(['queued', 'sent', 'skipped_no_email'] as const)('retry of a %s delivery is 409 and queues nothing', async (status) => {
      await review().expect(200);
      deliveries.rows.get(ID)!.status = status;
      await api(app, 'ops').post(`/tickets/${ID}/delivery/retry`).expect(409);
      expect(replyQueue.adds).toHaveLength(1);
    });

    it('retry for a ticket with no delivery is 409', async () => {
      await api(app, 'ops').post(`/tickets/${OTHER}/delivery/retry`).expect(409);
    });

    it('a retry whose job cannot be queued is 503', async () => {
      await review().expect(200);
      deliveries.rows.get(ID)!.status = 'failed';
      replyQueue.addError = new QueueUnavailableError();
      await api(app, 'ops').post(`/tickets/${ID}/delivery/retry`).expect(503);
      expect(deliveries.rows.get(ID)?.status).toBe('failed'); // put back, so Retry can be pressed again
    });

    it('a bad id is 400; a submitter is refused (403) for both routes', async () => {
      await api(app, 'ops').get('/tickets/not-a-uuid/delivery').expect(400);
      await api(app, 'ops').post('/tickets/not-a-uuid/delivery/retry').expect(400);
      await api(app, 'alice').get(`/tickets/${ID}/delivery`).expect(403);
      await api(app, 'alice').post(`/tickets/${ID}/delivery/retry`).expect(403);
    });

    it('an unauthenticated caller gets 401', async () => {
      const { default: request } = await import('supertest');
      await request(app.getHttpServer()).get(`/tickets/${ID}/delivery`).expect(401);
      await request(app.getHttpServer()).post(`/tickets/${ID}/delivery/retry`).expect(401);
    });
  });

  describe('the routes are not shadowed by the existing /tickets/:id routes', () => {
    beforeEach(() => start());
    it('GET /tickets/:id still reads the ticket from Python; /delivery does not', async () => {
      await api(app, 'ops').get(`/tickets/${ID}`).expect(200);
      expect(calls.map((c) => c.url)).toEqual([expect.stringMatching(new RegExp(`/tickets/${ID}$`))]);
      calls.length = 0;
      await api(app, 'ops').get(`/tickets/${ID}/delivery`).expect(200);
      expect(calls).toEqual([]);
    });
    it('POST /tickets/:id/review still reviews; /delivery/retry is its own route', async () => {
      await review().expect(200);
      expect(calls.at(-1)?.url).toMatch(/\/review$/);
      deliveries.rows.get(ID)!.status = 'failed';
      calls.length = 0;
      await api(app, 'ops').post(`/tickets/${ID}/delivery/retry`).expect(201);
      expect(calls).toEqual([]);
    });
    it('/tickets/counts and /tickets/reference/:ref are untouched', async () => {
      python.body = { triaged: 0, pending_review: 0, approved: 1, edited: 0, rejected: 0 };
      await api(app, 'ops').get('/tickets/counts').expect(200);
      python.body = TICKET;
      await api(app, 'ops').get('/tickets/reference/TKT-ABC234').expect(200);
    });
  });
});
