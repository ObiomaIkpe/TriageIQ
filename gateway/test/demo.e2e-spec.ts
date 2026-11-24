import { getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COUNTER_STORE } from '../src/auth/login-limiter.js';
import { PG_POOL } from '../src/database/database.constants.js';
import { DEMO_EMAIL } from '../src/demo/demo.constants.js';
import { FETCH } from '../src/health/health.constants.js';
import { REPLY_QUEUE } from '../src/mail/mail.constants.js';
import { ReplyDeliveryRepository } from '../src/mail/reply-delivery.repository.js';
import { PUBLIC_CLOCK, PUBLIC_STORE, TURNSTILE_TIMEOUT_MS } from '../src/public-tickets/public.constants.js';
import { SESSION_CLOCK, SESSION_STORE } from '../src/sessions/session.constants.js';
import { SessionService } from '../src/sessions/session.service.js';
import { PasswordHasher } from '../src/users/password-hasher.js';
import { UsersRepository } from '../src/users/users.repository.js';
import { startAppWithFakeQueue, stubEnv } from './app-helpers.js';
import { TEST_ORIGIN, api, stubAuthEnv } from './auth-helpers.js';
import { FakeQueue } from './fake-queue.js';
import { FakeReplyQueue, MemoryDeliveries } from './mail-fakes.js';
import { FakeClock, MemoryCounterStore, MemoryPublicStore, MemorySessionStore, MemoryUsers } from './memory-stores.js';

/**
 * The demo room, through the real HTTP stack: the switch, the demo login, the wall (which side of Python's data each caller is sent
 * to), "demo is never emailed", the routes a demo visitor cannot reach, the per-IP buckets, and a visitor's own test ticket.
 * Python is a fake that records every call it receives.
 */
const DUMMY_SECRET = '1x0000000000000000000000000000000AA';
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const ID = '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34';
const REF = 'TKT-ABC234';
const PASSWORD = 'a long and unusual passphrase';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let keyCounter = 0;
const newKey = () => `demo-form-${(keyCounter += 1)}`;

interface PythonCall {
  method: string;
  url: string;
  scope: string | null;
  body: unknown;
}

describe('demo mode (fake Python, fake Turnstile, in-memory stores)', () => {
  let app: NestExpressApplication;
  let clock: FakeClock;
  let users: MemoryUsers;
  let sessionStore: MemorySessionStore;
  let counters: MemoryCounterStore;
  let store: MemoryPublicStore;
  let queue: FakeQueue;
  let replyQueue: FakeReplyQueue;
  let deliveries: MemoryDeliveries;
  let python: PythonCall[];
  let turnstileOk: boolean;
  let python404: boolean;
  let hashVerify: ReturnType<typeof vi.spyOn>;

  /** A Python ticket record, as the real one would answer for the scope it was asked. */
  const record = (scope: string | null, over: Record<string, unknown> = {}) => ({
    ticket_id: ID,
    reference: REF,
    status: 'approved',
    subject: 'Locked out',
    body: 'b',
    final_reply: 'Wait one hour.',
    customer_name: 'Maya',
    customer_email: 'maya@example.com',
    reviewed_by: null,
    is_demo: scope === 'demo',
    ...over,
  });

  async function start(env: Record<string, string> = {}) {
    stubEnv();
    stubAuthEnv();
    const { validateEnv } = await import('../src/config/env.schema.js');
    const typed = validateEnv({
      ...process.env,
      DEMO_MODE: 'true',
      PUBLIC_FORM_ENABLED: 'true',
      TURNSTILE_SECRET_KEY: DUMMY_SECRET,
      TRUST_PROXY: 'true', // one hop: the last X-Forwarded-For entry is the client, so a test can be "from" different IPs
      MAIL_ENABLED: 'true',
      SMTP_HOST: 'smtp.example.com',
      MAIL_FROM: 'support@example.com',
      ...env,
    }) as unknown as Record<string, unknown>;
    const config = { get: (key: string) => typed[key], getOrThrow: (key: string) => typed[key] };

    clock = new FakeClock();
    users = new MemoryUsers(clock);
    sessionStore = new MemorySessionStore(clock);
    counters = new MemoryCounterStore(clock);
    store = new MemoryPublicStore(clock);
    queue = new FakeQueue();
    replyQueue = new FakeReplyQueue();
    deliveries = new MemoryDeliveries();
    python = [];
    turnstileOk = true;
    python404 = false;

    const fetchFn = (async (url: string, init: RequestInit) => {
      if (String(url).includes('siteverify')) {
        return json(turnstileOk ? { success: true, hostname: 'example.com', 'error-codes': [] } : { success: false, 'error-codes': ['invalid-input-response'] });
      }
      const u = new URL(String(url));
      const scope = u.searchParams.get('scope');
      python.push({ method: String(init?.method ?? 'GET'), url: `${u.pathname}${u.search}`, scope, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
      if (python404 && u.pathname !== '/tickets' && u.pathname !== '/tickets/counts') return json({ detail: 'Ticket not found' }, 404);
      if (u.pathname === '/tickets/counts') return json({ triaged: 0, pending_review: 1, approved: 0, edited: 0, rejected: 0 });
      if (u.pathname === '/tickets') return json([record(scope)]);
      return json(record(scope)); // by id, by reference, and a review
    }) as unknown as typeof fetch;

    const pool = {
      query: async (_sql: string, values: string[]) => ({ rows: [{ reference: values?.[0] }], rowCount: 1 }),
      connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined }),
      end: async () => undefined,
      on: () => undefined,
    };
    app = await startAppWithFakeQueue(queue, 100, (b) =>
      b
        .overrideProvider(ConfigService).useValue(config)
        .overrideProvider(PG_POOL).useValue(pool)
        .overrideProvider(SESSION_CLOCK).useValue(clock.fn)
        .overrideProvider(SESSION_STORE).useValue(sessionStore)
        .overrideProvider(COUNTER_STORE).useValue(counters)
        .overrideProvider(UsersRepository).useValue(users)
        .overrideProvider(PUBLIC_STORE).useValue(store)
        .overrideProvider(PUBLIC_CLOCK).useValue(clock.fn)
        .overrideProvider(TURNSTILE_TIMEOUT_MS).useValue(150)
        .overrideProvider(FETCH).useValue(fetchFn)
        .overrideProvider(getQueueToken(REPLY_QUEUE)).useValue(replyQueue)
        .overrideProvider(ReplyDeliveryRepository).useValue(deliveries),
    );
    hashVerify = vi.spyOn(app.get(PasswordHasher, { strict: false }), 'verify');
  }

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  const http = () => request(app.getHttpServer());
  const demoLogin = (ip = '203.0.113.1', origin: string | null = TEST_ORIGIN) => {
    const req = http().post('/auth/demo-login').set('X-Forwarded-For', ip);
    return origin === null ? req : req.set('Origin', origin);
  };
  const cookieOf = (response: { headers: Record<string, unknown> }) =>
    ((response.headers['set-cookie'] as string[] | undefined) ?? []).find((c) => c.startsWith('tiq_session='))?.split(';')[0] as string;
  async function demoCookie(ip = '203.0.113.1') {
    const response = await demoLogin(ip).expect(200);
    return cookieOf(response);
  }
  /** A logged-in REAL reviewer (a session made directly: the login itself is tested elsewhere). */
  async function realCookie() {
    const user = users.add({ email: 'ada@example.com', passwordHash: 'x', displayName: 'Ada Lovelace' });
    return `tiq_session=${(await app.get(SessionService).create(user.id)).token}`;
  }
  const as = (cookie: string, ip = '203.0.113.1') => ({
    get: (url: string) => http().get(url).set('Cookie', cookie).set('X-Forwarded-For', ip),
    post: (url: string) => http().post(url).set('Cookie', cookie).set('Origin', TEST_ORIGIN).set('X-Forwarded-For', ip),
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe('DEMO_MODE=false: nothing is reachable', () => {
    it('every demo route is a 404, for everyone, before any login is asked for', async () => {
      await start({ DEMO_MODE: 'false' });
      const real = await realCookie();
      await http().get('/demo/status').expect(404);
      await demoLogin().expect(404);
      await http().post('/demo/tickets').set('Origin', TEST_ORIGIN).send({}).expect(404); // no credential at all: 404, not 401
      await api(app, 'ops').post('/demo/tickets').send({}).expect(404); // an API key: 404, not 403
      await as(real).post('/demo/tickets').send({}).expect(404); // a real reviewer's session: 404, not 403
      expect([...users.rows.values()].filter((u) => u.role === 'demo')).toEqual([]); // and no demo user was made
    });

    it('the real room is untouched: reviewer reads still work and are sent to Python as real', async () => {
      await start({ DEMO_MODE: 'false' });
      await api(app, 'ops').get('/tickets').expect(200);
      expect(python[0]?.scope).toBe('real');
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe('the demo user and the demo login', () => {
    it('the demo user is created at startup, with role demo and a password hash that matches nothing', async () => {
      await start();
      const demo = [...users.rows.values()].filter((u) => u.role === 'demo');
      expect(demo).toHaveLength(1);
      expect(demo[0]).toMatchObject({ email: DEMO_EMAIL, displayName: 'Demo Reviewer', disabledAt: null });
      expect(demo[0].passwordHash).toBe('!demo-account-has-no-password');
    });

    it('GET /demo/status says the demo is on (the login page uses it to show the button)', async () => {
      await start();
      expect((await http().get('/demo/status').expect(200)).body).toEqual({ enabled: true });
    });

    it('POST /auth/demo-login needs no body and gives a Secure, HttpOnly session cookie that lasts ONE hour', async () => {
      await start();
      const response = await demoLogin().expect(200);
      expect(response.body.user).toMatchObject({ email: DEMO_EMAIL, display_name: 'Demo Reviewer', role: 'demo' });
      const cookie = ((response.headers['set-cookie'] as unknown as string[] | undefined) ?? []).find((c) => c.startsWith('tiq_session='))!;
      expect(cookie).toContain('Max-Age=3600');
      expect(cookie).toMatch(/HttpOnly/);
      expect(cookie).toMatch(/Secure/);
      expect(cookie).toMatch(/SameSite=Strict/);
      const me = await as(cookieOf(response)).get('/auth/me').expect(200);
      expect(me.body.user.role).toBe('demo');
    });

    it('the Origin is checked like the real login (no Origin or a foreign one: 403)', async () => {
      await start();
      await demoLogin('203.0.113.1', null).expect(403);
      await demoLogin('203.0.113.1', 'https://evil.example').expect(403);
      expect(sessionStore.entries.size).toBe(0);
    });

    it('the session ends one hour after the click, however busy it is (the idle timeout never fires: it is used all along)', async () => {
      await start();
      const cookie = await demoCookie();
      for (const minutes of [20, 20, 15]) {
        clock.advanceSeconds(minutes * 60);
        await as(cookie).get('/auth/me').expect(200); // 20, 40, 55 minutes after login
      }
      clock.advanceSeconds(10 * 60); // 65 minutes after login
      await as(cookie).get('/auth/me').expect(401);
    });

    it('a real login session is NOT shortened: the one-hour life belongs to the demo session only', async () => {
      await start();
      const real = await realCookie();
      for (let i = 0; i < 3; i += 1) {
        clock.advanceSeconds(30 * 60);
        await as(real).get('/auth/me').expect(200); // 30, 60 and 90 minutes after login, used throughout: still alive
      }
    });

    it('a new demo login replaces the session the browser carried (no session fixation)', async () => {
      await start();
      const first = await demoCookie();
      await http().post('/auth/demo-login').set('Origin', TEST_ORIGIN).set('Cookie', first).set('X-Forwarded-For', '203.0.113.1').expect(200);
      await as(first).get('/auth/me').expect(401);
    });

    it('logins are limited per client IP, and another IP is not affected', async () => {
      await start({ DEMO_LOGIN_MAX_PER_IP_PER_HOUR: '3' });
      for (let i = 0; i < 3; i += 1) await demoLogin('198.51.100.7').expect(200);
      const limited = await demoLogin('198.51.100.7').expect(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      await demoLogin('198.51.100.8').expect(200);
    });

    it('the password login for the demo user is ALWAYS refused, whatever is typed, and looks like any other failure', async () => {
      await start({ LOGIN_MAX_FAILURES_PER_EMAIL: '1000', LOGIN_MAX_FAILURES_PER_IP: '1000' });
      const attempt = (email: string, password: string) =>
        http().post('/auth/login').set('Origin', TEST_ORIGIN).set('Content-Type', 'application/json').set('X-Forwarded-For', '203.0.113.9').send({ email, password });
      const unknown = await attempt('nobody@example.com', PASSWORD).expect(401);
      for (const password of ['', 'x', PASSWORD, '!demo-account-has-no-password', 'demo']) {
        const res = await attempt(DEMO_EMAIL, password || 'a');
        expect([401, 400]).toContain(res.status);
      }
      const res = await attempt(DEMO_EMAIL, PASSWORD).expect(401);
      expect(res.body).toEqual(unknown.body); // the same words as an unknown account
      expect(sessionStore.entries.size).toBe(0);
    });

    it('even a demo row that HAS a real password hash cannot log in with it (the role itself is refused)', async () => {
      await start();
      const hasher = app.get(PasswordHasher, { strict: false });
      const demo = [...users.rows.values()].find((u) => u.role === 'demo')!;
      demo.passwordHash = await hasher.hash(PASSWORD);
      await http().post('/auth/login').set('Origin', TEST_ORIGIN).set('Content-Type', 'application/json').send({ email: DEMO_EMAIL, password: PASSWORD }).expect(401);
      expect(sessionStore.entries.size).toBe(0);
      expect(hashVerify).toHaveBeenCalled(); // it still did the work of a failed login (no timing tell)
    });

    it('the demo login is never locked by the failed-login limiter: it works after the email has been hammered', async () => {
      await start({ LOGIN_MAX_FAILURES_PER_EMAIL: '2', LOGIN_MAX_FAILURES_PER_IP: '1000' });
      for (let i = 0; i < 4; i += 1) {
        await http().post('/auth/login').set('Origin', TEST_ORIGIN).set('Content-Type', 'application/json').set('X-Forwarded-For', '203.0.113.50').send({ email: DEMO_EMAIL, password: 'wrong wrong wrong' });
      }
      const locked = await http().post('/auth/login').set('Origin', TEST_ORIGIN).set('Content-Type', 'application/json').set('X-Forwarded-For', '203.0.113.50').send({ email: DEMO_EMAIL, password: 'wrong wrong wrong' });
      expect(locked.status).toBe(429); // the password path IS limited...
      await demoLogin('203.0.113.50').expect(200); // ...the demo button is not
    });

    it('a demo user an operator disabled stays out', async () => {
      await start();
      [...users.rows.values()].find((u) => u.role === 'demo')!.disabledAt = new Date();
      await demoLogin().expect(401);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe('the wall: which side of Python each caller is sent to', () => {
    const lastScope = () => python.at(-1)?.scope;

    it('the demo principal is sent with scope=demo on every ticket route', async () => {
      await start();
      const cookie = await demoCookie();
      await as(cookie).get('/tickets?status=pending_review').expect(200);
      expect(lastScope()).toBe('demo');
      await as(cookie).get('/tickets/counts').expect(200);
      expect(lastScope()).toBe('demo');
      await as(cookie).get(`/tickets/reference/${REF}`).expect(200);
      expect(lastScope()).toBe('demo');
      await as(cookie).get(`/tickets/${ID}`).expect(200);
      expect(lastScope()).toBe('demo');
      await as(cookie).post(`/tickets/${ID}/review`).send({ action: 'approve' }).expect(200);
      expect(lastScope()).toBe('demo');
      expect(python.every((c) => c.scope === 'demo')).toBe(true);
    });

    it('every REAL principal (an API client, a logged-in reviewer) is sent with scope=real', async () => {
      await start();
      const real = await realCookie();
      await api(app, 'ops').get('/tickets').expect(200);
      await api(app, 'ops').get('/tickets/counts').expect(200);
      await api(app, 'ops').get(`/tickets/${ID}`).expect(200);
      await api(app, 'ops').get(`/tickets/reference/${REF}`).expect(200);
      await api(app, 'ops').post(`/tickets/${ID}/review`).send({ action: 'approve' }).expect(200);
      await as(real).get('/tickets').expect(200);
      await as(real).get('/tickets/counts').expect(200);
      await as(real).post(`/tickets/${ID}/review`).send({ action: 'reject' }).expect(200);
      expect(python).toHaveLength(8);
      expect(python.every((c) => c.scope === 'real')).toBe(true);
    });

    it('a scope the CALLER puts in the query is ignored: the principal decides', async () => {
      await start();
      const cookie = await demoCookie();
      await as(cookie).get('/tickets?scope=real&status=approved').expect(200);
      expect(python.at(-1)?.url).toBe('/tickets?status=approved&scope=demo'); // scope=real was dropped, not forwarded
      await api(app, 'ops').get('/tickets?scope=demo').expect(200);
      expect(python.at(-1)?.scope).toBe('real');
    });

    it('a 404 from Python (a ticket on the other side of the wall) reaches the visitor as a 404 with Python\'s own words', async () => {
      await start();
      python404 = true;
      const cookie = await demoCookie();
      const response = await as(cookie).get(`/tickets/${ID}`).expect(404);
      expect(response.body).toEqual({ detail: 'Ticket not found' });
      await as(cookie).get(`/tickets/reference/${REF}`).expect(404);
      await as(cookie).post(`/tickets/${ID}/review`).send({ action: 'approve' }).expect(404);
    });

    it('the delivery routes are not for the demo visitor (403): status, retry', async () => {
      await start();
      const cookie = await demoCookie();
      await as(cookie).get(`/tickets/${ID}/delivery`).expect(403);
      await as(cookie).post(`/tickets/${ID}/delivery/retry`).expect(403);
    });

    it('dead letters are not for the demo visitor (403)', async () => {
      await start();
      const cookie = await demoCookie();
      await as(cookie).get('/dead-letters').expect(403);
      await as(cookie).post('/dead-letters/3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34/retry').expect(403);
    });

    it('the demo visitor cannot create a REAL ticket through the API intake route (403)', async () => {
      await start();
      const cookie = await demoCookie();
      await as(cookie).post('/tickets').set('Content-Type', 'application/json').send({ subject: 's', body: 'b' }).expect(403);
      expect(queue.jobs?.size ?? 0).toBe(0);
    });

    it('the demo visitor sees only its own jobs: another client\'s job is a 404', async () => {
      await start();
      const cookie = await demoCookie();
      const created = await api(app, 'alice').post('/tickets').send({ subject: 's', body: 'b' }).expect(202);
      await as(cookie).get(`/jobs/${created.body.job_id}`).expect(404);
      await api(app, 'ops').get(`/jobs/${created.body.job_id}`).expect(200); // a real reviewer still sees every job
    });

    it('real principals cannot use the demo submit route (403)', async () => {
      await start();
      const real = await realCookie();
      await as(real).post('/demo/tickets').send({ subject: 's', message: 'm', turnstile_token: DUMMY_TOKEN }).expect(403);
      await api(app, 'ops').post('/demo/tickets').send({ subject: 's', message: 'm', turnstile_token: DUMMY_TOKEN }).expect(403);
      await api(app, 'alice').post('/demo/tickets').send({ subject: 's', message: 'm', turnstile_token: DUMMY_TOKEN }).expect(403);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe('demo is NEVER emailed', () => {
    it('approving or editing a demo ticket as the demo visitor makes no delivery row and no email job (mail is ON)', async () => {
      await start();
      const cookie = await demoCookie();
      await as(cookie).post(`/tickets/${ID}/review`).send({ action: 'approve' }).expect(200);
      await as(cookie).post(`/tickets/${ID}/review`).send({ action: 'edit', edited_reply: 'Better.' }).expect(200);
      expect(deliveries.rows.size).toBe(0);
      expect(replyQueue.adds).toEqual([]);
    });

    it('control: the same approval by a REAL reviewer does queue the email', async () => {
      await start();
      await api(app, 'ops').post(`/tickets/${ID}/review`).send({ action: 'approve' }).expect(200);
      expect(replyQueue.adds).toHaveLength(1);
      expect(deliveries.rows.size).toBe(1);
    });

    it('second layer: even if a DEMO ticket were handed to the trigger, it refuses it (no row, no job)', async () => {
      await start();
      const { ReplyDeliveryService } = await import('../src/mail/reply-delivery.service.js');
      const result = await app.get(ReplyDeliveryService, { strict: false }).onApproved({ ticket_id: ID, reference: REF, status: 'approved', customer_email: 'maya@example.com', is_demo: true });
      expect(result).toBe('ignored');
      expect(deliveries.rows.size).toBe(0);
      expect(replyQueue.adds).toEqual([]);
    });

    it('the demo visitor is shown the email that WOULD have been sent, built like the real one', async () => {
      await start();
      const cookie = await demoCookie();
      const reviewed = await as(cookie).post(`/tickets/${ID}/review`).send({ action: 'approve' }).expect(200);
      expect(reviewed.body.email_preview).toEqual({
        to: 'maya@example.com',
        subject: 'Re: Locked out [TKT-ABC234]',
        body: 'Wait one hour.\n\n--\nReference: TKT-ABC234\n',
      });
      const read = await as(cookie).get(`/tickets/${ID}`).expect(200);
      expect(read.body.email_preview.subject).toBe('Re: Locked out [TKT-ABC234]');
    });

    it('a real reviewer never gets an email_preview', async () => {
      await start();
      const read = await api(app, 'ops').get(`/tickets/${ID}`).expect(200);
      expect(read.body).not.toHaveProperty('email_preview');
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe('rate limits are per client IP for the demo principal', () => {
    it('two visitors on different IPs sharing the demo user do not share a bucket', async () => {
      await start({ RATE_LIMIT_PER_MINUTE: '3' });
      const cookie = await demoCookie('198.51.100.1');
      for (let i = 0; i < 3; i += 1) await as(cookie, '198.51.100.1').get('/tickets/counts').expect(200);
      const limited = await as(cookie, '198.51.100.1').get('/tickets/counts').expect(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      await as(cookie, '198.51.100.2').get('/tickets/counts').expect(200); // another visitor, same user: its own bucket
    });

    it('a real principal is still counted per principal, not per IP', async () => {
      await start({ RATE_LIMIT_PER_MINUTE: '3' });
      for (let i = 0; i < 3; i += 1) await api(app, 'ops').get('/tickets/counts').set('X-Forwarded-For', `198.51.100.${i + 1}`).expect(200);
      await api(app, 'ops').get('/tickets/counts').set('X-Forwarded-For', '198.51.100.99').expect(429); // new IP, same client: the same bucket
    });
  });

  // ------------------------------------------------------------------------------------------------------------------------------
  describe('a visitor\'s own test ticket: POST /demo/tickets', () => {
    const body = (over: Record<string, unknown> = {}) => ({ subject: 'My test', message: 'Please help me test this', turnstile_token: DUMMY_TOKEN, ...over });
    const submit = (cookie: string, payload: unknown = body(), key: string | null = newKey(), ip = '203.0.113.1') => {
      const req = as(cookie, ip).post('/demo/tickets').set('Content-Type', 'application/json');
      if (key !== null) req.set('Idempotency-Key', key);
      return req.send(payload as object);
    };

    it('is accepted: 202 with a reference, and the job is marked demo with the fixed fake customer', async () => {
      await start();
      const cookie = await demoCookie();
      const response = await submit(cookie).expect(202);
      expect(response.body.reference).toMatch(/^TKT-[A-Z2-9]{6}$/);
      const [job] = [...queue.jobs.values()];
      expect(job.data).toMatchObject({
        subject: 'My test',
        body: 'Please help me test this',
        demo: true,
        customer_name: 'Demo Visitor',
        customer_email: 'visitor@example.com',
        customer_id: 'demo',
        client: 'demo-form',
        reference: response.body.reference,
      });
    });

    it('a visitor cannot choose the customer or any other field: they are refused', async () => {
      await start();
      const cookie = await demoCookie();
      for (const extra of [{ name: 'Me' }, { email: 'me@example.com' }, { is_demo: false }, { customer_email: 'x@example.com' }]) {
        await submit(cookie, body(extra)).expect(400);
      }
      expect(queue.jobs.size).toBe(0);
    });

    it('needs the Idempotency-Key and valid text', async () => {
      await start();
      const cookie = await demoCookie();
      await submit(cookie, body(), null).expect(400);
      await submit(cookie, body({ subject: '' })).expect(400);
      await submit(cookie, body({ message: 'x'.repeat(5001) })).expect(400);
    });

    it('a failed Turnstile check is 403 and queues nothing, and does not use a cap slot', async () => {
      await start();
      const cookie = await demoCookie();
      turnstileOk = false;
      await submit(cookie).expect(403);
      expect(queue.jobs.size).toBe(0);
      expect(store.capUsed(new Date(clock.now).toISOString().slice(0, 10), 'demo:cap:')).toBe(0);
    });

    it('respects DEMO_DAILY_CAP: the next one is 503 with Retry-After, and a refused ticket queues nothing', async () => {
      await start({ DEMO_DAILY_CAP: '2', DEMO_SUBMIT_MAX_PER_IP_PER_HOUR: '50' });
      const cookie = await demoCookie();
      await submit(cookie).expect(202);
      await submit(cookie).expect(202);
      const refused = await submit(cookie).expect(503);
      expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
      expect(queue.jobs.size).toBe(2);
    });

    it('uses its OWN counters: demo submissions do not use up the public form\'s daily cap or IP limit', async () => {
      await start({ DEMO_DAILY_CAP: '5', PUBLIC_DAILY_CAP: '5' });
      const cookie = await demoCookie();
      await submit(cookie).expect(202);
      const day = new Date(clock.now).toISOString().slice(0, 10);
      expect(store.capUsed(day, 'demo:cap:')).toBe(1);
      expect(store.capUsed(day)).toBe(0); // the public form's counter is untouched
      expect([...store.prefixes].sort()).toEqual(['demo:login:ip:', 'demo:submit:ip:']); // never the public form's (empty) prefix
    });

    it('is limited per IP per hour', async () => {
      await start({ DEMO_SUBMIT_MAX_PER_IP_PER_HOUR: '2', DEMO_DAILY_CAP: '50' });
      const cookie = await demoCookie();
      await submit(cookie, body(), newKey(), '198.51.100.5').expect(202);
      await submit(cookie, body(), newKey(), '198.51.100.5').expect(202);
      await submit(cookie, body(), newKey(), '198.51.100.5').expect(429);
      await submit(cookie, body(), newKey(), '198.51.100.6').expect(202);
    });

    it('a retry with the same key and message makes one ticket and spends nothing more', async () => {
      await start();
      const cookie = await demoCookie();
      const key = newKey();
      const first = await submit(cookie, body(), key).expect(202);
      const again = await submit(cookie, body({ turnstile_token: 'a-new-token' }), key).expect(202);
      expect(again.body.reference).toBe(first.body.reference);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(queue.jobs.size).toBe(1);
    });

    it('is only for a logged-in demo visitor: no cookie is 401', async () => {
      await start();
      await http().post('/demo/tickets').set('Origin', TEST_ORIGIN).set('Idempotency-Key', newKey()).send(body()).expect(401);
    });

    it('the public form is unchanged: it still makes a REAL ticket (no demo flag, the visitor\'s own name)', async () => {
      await start();
      const response = await http()
        .post('/public/tickets')
        .set({ Origin: TEST_ORIGIN, 'Idempotency-Key': newKey() })
        .send({ name: 'Real Person', email: 'real@example.com', subject: 'Real', message: 'Real message', turnstile_token: DUMMY_TOKEN })
        .expect(202);
      const job = [...queue.jobs.values()].find((j) => j.data.reference === response.body.reference)!;
      expect(job.data).toMatchObject({ customer_name: 'Real Person', client: 'public-form' });
      expect(job.data).not.toHaveProperty('demo');
    });
  });
});
