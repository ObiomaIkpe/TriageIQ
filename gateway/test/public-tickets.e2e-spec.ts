import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { afterEach, beforeEach, vi } from 'vitest';
import { FETCH } from '../src/health/health.constants.js';
import { PUBLIC_CLOCK, PUBLIC_STORE, TURNSTILE_TIMEOUT_MS } from '../src/public-tickets/public.constants.js';
import { startAppWithFakeQueue, stubEnv } from './app-helpers.js';
import { TEST_ORIGIN, stubAuthEnv } from './auth-helpers.js';
import { FakeQueue } from './fake-queue.js';
import { FakeClock, MemoryPublicStore } from './memory-stores.js';

/**
 * POST /public/tickets with a fake Turnstile server (an in-process fetch) and in-memory counters.
 * Cloudflare's own dummy values are used where they matter: the always-pass secret answers only the dummy token.
 */
const DUMMY_SECRET = '1x0000000000000000000000000000000AA';
const DUMMY_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
const NAME = 'Ọbiọma Ụzọ';
const EMAIL = 'private.person@example.com';
const BODY = { name: NAME, email: EMAIL, subject: 'SecretSubjectText', message: 'SecretMessageText', turnstile_token: DUMMY_TOKEN };
let keyCounter = 0;
const newKey = () => `form-load-${(keyCounter += 1)}`;

type Verdict = () => Response | Promise<Response>;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('POST /public/tickets (fake Turnstile, fake queue)', () => {
  let app: NestExpressApplication;
  let queue: FakeQueue;
  let clock: FakeClock;
  let store: MemoryPublicStore;
  let turnstileCalls: URLSearchParams[];
  let verdict: Verdict;
  let lines: string[];

  async function start(env: Record<string, string> = {}) {
    stubEnv();
    stubAuthEnv();
    // The app reads its config once per file, so each test's settings go in through a ConfigService stand-in
    // built with the real validateEnv (same parsing, same defaults).
    const { validateEnv } = await import('../src/config/env.schema.js');
    const typed = validateEnv({ ...process.env, PUBLIC_FORM_ENABLED: 'true', TURNSTILE_SECRET_KEY: DUMMY_SECRET, ...env }) as unknown as Record<string, unknown>;
    const config = { get: (key: string) => typed[key], getOrThrow: (key: string) => typed[key] };
    clock = new FakeClock();
    store = new MemoryPublicStore(clock);
    queue = new FakeQueue();
    turnstileCalls = [];
    verdict = () => json({ success: true, hostname: 'example.com', challenge_ts: '2026-11-21T12:00:00Z', 'error-codes': [] });
    const fetchFn = (async (_url: string, init: RequestInit) => {
      turnstileCalls.push(new URLSearchParams(init.body as URLSearchParams));
      const aborted = new Promise<never>((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'TimeoutError' }))),
      );
      return Promise.race([Promise.resolve().then(() => verdict()), aborted]);
    }) as unknown as typeof fetch;
    app = await startAppWithFakeQueue(queue, 100, (b) =>
      b
        .overrideProvider(ConfigService).useValue(config)
        .overrideProvider(PUBLIC_STORE).useValue(store)
        .overrideProvider(PUBLIC_CLOCK).useValue(clock.fn)
        .overrideProvider(TURNSTILE_TIMEOUT_MS).useValue(150)
        .overrideProvider(FETCH).useValue(fetchFn),
    );
  }

  const post = (body: unknown = BODY, headers: Record<string, string | undefined> = {}) => {
    const h: Record<string, string> = { Origin: TEST_ORIGIN, 'Idempotency-Key': newKey() };
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) delete h[k];
      else h[k] = v;
    }
    return request(app.getHttpServer()).post('/public/tickets').set(h).send(body as object);
  };

  beforeEach(() => {
    lines = [];
    for (const m of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, m).mockImplementation((msg: unknown) => void lines.push(String(msg)));
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await app?.close();
  });

  describe('accepted', () => {
    beforeEach(() => start());

    it('202 with only a reference and a thank you; the job carries the contact details and the same reference', async () => {
      const res = await post().expect(202);
      expect(res.body).toEqual({ reference: expect.stringMatching(/^TKT-[A-HJKMNP-Z2-9]{6}$/), message: 'Thanks, we received your message.' });
      expect(JSON.stringify(res.body)).not.toMatch(/job|status|category|urgency/i);
      expect(queue.added).toHaveLength(1);
      expect(queue.added[0].data).toEqual({
        subject: 'SecretSubjectText',
        body: 'SecretMessageText',
        customer_id: 'public-form',
        client: 'public-form',
        reference: res.body.reference,
        customer_name: NAME,
        customer_email: EMAIL,
        received_at: expect.any(String),
      });
    });

    it('stores the email trimmed and lower-cased', async () => {
      await post({ ...BODY, email: '  Mixed.Case@Example.COM ' }).expect(202);
      expect(queue.added[0].data.customer_email).toBe('mixed.case@example.com');
    });

    it('asks Turnstile with the secret, the token and the caller IP, exactly once', async () => {
      await post().expect(202);
      expect(turnstileCalls).toHaveLength(1);
      expect(turnstileCalls[0].get('secret')).toBe(DUMMY_SECRET);
      expect(turnstileCalls[0].get('response')).toBe(DUMMY_TOKEN);
      expect(turnstileCalls[0].get('remoteip')).toBeTruthy();
    });

    it('needs no API key and no login (a key would not matter)', async () => {
      await post().expect(202);
    });
  });

  describe('disabled', () => {
    it('answers 404 and queues nothing, before any other check', async () => {
      await start({ PUBLIC_FORM_ENABLED: 'false', TURNSTILE_SECRET_KEY: '' });
      await post().expect(404);
      await post({}, { Origin: 'http://evil.example' }).expect(404);
      expect(queue.added).toHaveLength(0);
      expect(turnstileCalls).toHaveLength(0);
    });
  });

  describe('Origin (a cheap filter, not security)', () => {
    beforeEach(() => start());
    it.each([[undefined], ['http://evil.example'], ['null'], [`${TEST_ORIGIN}/`]])('Origin %s -> 403, nothing else runs', async (origin) => {
      await post(BODY, { Origin: origin }).expect(403);
      expect(turnstileCalls).toHaveLength(0);
      expect(store.calls).toEqual([]);
      expect(queue.added).toHaveLength(0);
    });
    it('a script that sends the right Origin gets through to the real checks (so Origin alone protects nothing)', async () => {
      verdict = () => json({ success: false, 'error-codes': ['invalid-input-response'] });
      await post().expect(403); // stopped by Turnstile, not by Origin
      expect(turnstileCalls).toHaveLength(1);
    });
  });

  describe('schema and headers', () => {
    beforeEach(() => start());
    it('a bad body is 400 with field errors, no values echoed, and nothing is counted or called', async () => {
      const res = await post({ ...BODY, email: 'nope', name: '', extra: 'SECRETVALUE' }).expect(400);
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          { field: 'email', problem: 'is invalid' },
          { field: 'name', problem: 'must not be empty' },
          { field: 'extra', problem: 'unknown field' },
        ]),
      );
      expect(JSON.stringify(res.body)).not.toContain('SECRETVALUE');
      expect(turnstileCalls).toHaveLength(0);
      expect(store.calls).toEqual([]);
    });
    it('the Idempotency-Key is required (400) and checked like the existing one', async () => {
      const missing = await post(BODY, { 'Idempotency-Key': undefined }).expect(400);
      expect(missing.body.errors).toEqual([{ field: 'Idempotency-Key', problem: 'is required' }]);
      await post(BODY, { 'Idempotency-Key': 'bad key!' }).expect(400);
      await post(BODY, { 'Idempotency-Key': 'x'.repeat(101) }).expect(400);
    });
    it('another content type is 415', async () => {
      await request(app.getHttpServer())
        .post('/public/tickets').set({ Origin: TEST_ORIGIN, 'Idempotency-Key': newKey(), 'Content-Type': 'text/plain' }).send('hello').expect(415);
    });
    it('a body over 16 KB is 413 (the general limit is 100 KB) and nothing runs', async () => {
      await post({ ...BODY, message: 'x'.repeat(20000) }).expect(413);
      expect(turnstileCalls).toHaveLength(0);
      expect(queue.added).toHaveLength(0);
    });
    it('a message at the 5000 character limit fits inside the 16 KB route limit', async () => {
      await post({ ...BODY, message: 'ọ'.repeat(5000) }).expect(202);
    });
  });

  describe('idempotency', () => {
    beforeEach(() => start());
    it('a double submit with the same key makes one job and gives the same reference', async () => {
      const key = newKey();
      const first = await post(BODY, { 'Idempotency-Key': key }).expect(202);
      const second = await post(BODY, { 'Idempotency-Key': key }).expect(202);
      expect(second.body.reference).toBe(first.body.reference);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(queue.added).toHaveLength(1);
    });
    it('a replay with a new or spent token is still 202 and uses no Turnstile call, no IP slot and no cap slot', async () => {
      const key = newKey();
      await post(BODY, { 'Idempotency-Key': key }).expect(202);
      const calls = turnstileCalls.length;
      const ipCount = store.ips.size === 0 ? 0 : [...store.ips.values()][0].count;
      verdict = () => json({ success: false, 'error-codes': ['timeout-or-duplicate'] }); // the token is spent now
      await post({ ...BODY, turnstile_token: 'a-spent-token' }, { 'Idempotency-Key': key }).expect(202);
      expect(turnstileCalls).toHaveLength(calls);
      expect([...store.ips.values()][0].count).toBe(ipCount);
      expect(store.capUsed('2026-11-21')).toBe(1);
    });
    it('a replay works even when the IP is over its limit and the cap is full', async () => {
      const key = newKey();
      await post(BODY, { 'Idempotency-Key': key }).expect(202);
      for (let i = 0; i < 10; i += 1) await store.hitIp('::ffff:127.0.0.1', 3600);
      await post(BODY, { 'Idempotency-Key': key }).expect(202);
    });
    it('the same key with a different message is 422, like POST /tickets', async () => {
      const key = newKey();
      await post(BODY, { 'Idempotency-Key': key }).expect(202);
      await post({ ...BODY, message: 'something else' }, { 'Idempotency-Key': key }).expect(422);
      expect(queue.added).toHaveLength(1);
    });
    it('a client key that is named like the form cannot collide: its namespace is client:public-form', async () => {
      const key = newKey();
      await post(BODY, { 'Idempotency-Key': key }).expect(202);
      expect([...queue.kv.entries.keys()]).toEqual([`idem:client:public-form:${key}`]);
    });
  });

  describe('honeypot', () => {
    beforeEach(() => start());
    it('looks like a success with a random fake reference, queues nothing, calls no Turnstile, takes no cap slot', async () => {
      const res = await post({ ...BODY, website: 'http://buy-cheap.example' }).expect(202);
      expect(res.body).toEqual({ reference: expect.stringMatching(/^TKT-[A-HJKMNP-Z2-9]{6}$/), message: 'Thanks, we received your message.' });
      expect(queue.added).toHaveLength(0);
      expect(turnstileCalls).toHaveLength(0);
      expect(store.capUsed('2026-11-21')).toBe(0);
      expect(lines.join('\n')).toContain('outcome=honeypot');
    });
    it('counts toward the IP limit', async () => {
      await start({ PUBLIC_MAX_PER_IP_PER_HOUR: '2' });
      await post({ ...BODY, website: 'x' }).expect(202);
      await post({ ...BODY, website: 'x' }).expect(202);
      await post().expect(429);
    });
  });

  describe('per-IP limit', () => {
    it('the 6th request in an hour is 429 with Retry-After, and nothing after the limit runs', async () => {
      await start();
      for (let i = 0; i < 5; i += 1) await post().expect(202);
      const calls = turnstileCalls.length;
      const res = await post().expect(429);
      expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(3600);
      expect(res.body.message).toMatch(/too many/i);
      expect(turnstileCalls).toHaveLength(calls); // a rate-limited request never calls Turnstile
      expect(queue.added).toHaveLength(5);
      clock.advanceSeconds(3601);
      await post().expect(202); // the window ended
    });
    it('PUBLIC_MAX_PER_IP_PER_HOUR is honoured', async () => {
      await start({ PUBLIC_MAX_PER_IP_PER_HOUR: '1' });
      await post().expect(202);
      await post().expect(429);
    });
  });

  describe('Turnstile', () => {
    beforeEach(() => start());
    it('a failed check is 403 with the fixed message, nothing queued, no cap slot used', async () => {
      verdict = () => json({ success: false, 'error-codes': ['invalid-input-response'] });
      const res = await post().expect(403);
      expect(res.body).toEqual({ message: 'Verification failed, please try again.' });
      expect(queue.added).toHaveLength(0);
      expect(store.capUsed('2026-11-21')).toBe(0);
      expect(lines.join('\n')).toContain('turnstile_errors=invalid-input-response');
    });
    it('an already-spent token (timeout-or-duplicate) is 403', async () => {
      verdict = () => json({ success: false, 'error-codes': ['timeout-or-duplicate'] });
      await post().expect(403);
    });
    it.each([
      ['a 500', () => json({}, 500)],
      ['a 503', () => json({}, 503)],
      ['a network error', () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); }],
      ['a timeout', () => new Promise<Response>(() => undefined)],
      ['garbage', () => new Response('<html>nope</html>', { status: 200 })],
    ])('%s fails CLOSED: 503 "Please try again in a moment.", nothing queued', async (_name, answer) => {
      verdict = answer as Verdict;
      const res = await post().expect(503);
      expect(res.body).toEqual({ message: 'Please try again in a moment.' });
      expect(queue.added).toHaveLength(0);
      expect(store.capUsed('2026-11-21')).toBe(0);
    });
  });

  describe('hostname and action checks', () => {
    it('with TURNSTILE_EXPECTED_HOSTNAMES set, a different hostname is 403 and the dummy hostname example.com passes when listed', async () => {
      await start({ TURNSTILE_EXPECTED_HOSTNAMES: 'shop.example.org' });
      await post().expect(403); // the fake (like Cloudflare's dummy keys) reports example.com
      await app.close();
      await start({ TURNSTILE_EXPECTED_HOSTNAMES: 'example.com' });
      await post().expect(202);
    });
    it('with TURNSTILE_EXPECTED_ACTION set, a missing or different action is 403', async () => {
      await start({ TURNSTILE_EXPECTED_ACTION: 'public_ticket' });
      await post().expect(403);
      verdict = () => json({ success: true, hostname: 'example.com', action: 'public_ticket' });
      await post().expect(202);
    });
  });

  describe('daily cap', () => {
    it('when reached: 503 with Retry-After to UTC midnight and the fixed message; Turnstile ran, nothing queued', async () => {
      await start({ PUBLIC_DAILY_CAP: '2', PUBLIC_MAX_PER_IP_PER_HOUR: '100' });
      await post().expect(202);
      await post().expect(202);
      const res = await post().expect(503);
      expect(res.body).toEqual({ message: "We're receiving too many messages today. Please try again tomorrow." });
      expect(res.headers['retry-after']).toBe(String(12 * 3600));
      expect(queue.added).toHaveLength(2);
      clock.advanceSeconds(13 * 3600); // past UTC midnight
      await post().expect(202);
    });
    it('the slot is given back when the enqueue fails, so a failure does not eat the cap', async () => {
      await start({ PUBLIC_DAILY_CAP: '1' });
      queue.addError = new Error('queue write failed');
      const res = await post();
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(store.capUsed('2026-11-21')).toBe(0);
      queue.addError = undefined;
      await post().expect(202); // the one slot of the day is still there
    });
    it('a queue outage is 503 and gives the slot back too', async () => {
      await start({ PUBLIC_DAILY_CAP: '1' });
      queue.mode = 'fail';
      await post().expect(503);
      expect(store.capUsed('2026-11-21')).toBe(0);
    });
  });

  describe('privacy', () => {
    beforeEach(() => start({ PUBLIC_MAX_PER_IP_PER_HOUR: '100' }));
    it('no log line holds the name, email, subject, message, token or secret, across every outcome', async () => {
      await post().expect(202); // accepted
      const key = newKey();
      await post(BODY, { 'Idempotency-Key': key }).expect(202);
      await post(BODY, { 'Idempotency-Key': key }).expect(202); // replay
      await post({ ...BODY, website: 'x' }).expect(202); // honeypot
      await post({ ...BODY, email: 'bad' }).expect(400); // invalid
      verdict = () => json({ success: false, 'error-codes': ['invalid-input-response'] });
      await post().expect(403);
      verdict = () => json({}, 500);
      await post().expect(503);
      verdict = () => json({ success: true });
      store.failing = 'cap';
      await post().expect(503);
      store.failing = 'none';
      const log = lines.join('\n');
      for (const forbidden of [NAME, 'Ọbiọma', EMAIL, 'private.person', 'SecretSubjectText', 'SecretMessageText', DUMMY_TOKEN, DUMMY_SECRET, '1x00000']) {
        expect(log).not.toContain(forbidden);
      }
      for (const outcome of ['accepted', 'replay', 'honeypot', 'invalid', 'turnstile_failed', 'turnstile_unavailable']) {
        expect(log).toContain(`outcome=${outcome}`);
      }
      expect(log).toMatch(/outcome=accepted reference=TKT-[A-HJKMNP-Z2-9]{6} ip=\S+/);
    });
  });

  describe('POST /tickets still works for API clients', () => {
    beforeEach(() => start());
    it('returns a reference and puts the same one in the job', async () => {
      const { api } = await import('./auth-helpers.js');
      const res = await api(app, 'alice').post('/tickets').send({ subject: 'Hi', body: 'Help' }).expect(202);
      expect(res.body.reference).toMatch(/^TKT-[A-HJKMNP-Z2-9]{6}$/);
      expect(queue.added[0].data.reference).toBe(res.body.reference);
      expect(queue.added[0].data.customer_email).toBeUndefined();
    });
    it('an idempotent replay returns the first request\'s reference', async () => {
      const { api } = await import('./auth-helpers.js');
      const a = await api(app, 'alice').post('/tickets').set('Idempotency-Key', 'api-1').send({ subject: 'Hi', body: 'Help' }).expect(202);
      const b = await api(app, 'alice').post('/tickets').set('Idempotency-Key', 'api-1').send({ subject: 'Hi', body: 'Help' }).expect(202);
      expect(b.body.reference).toBe(a.body.reference);
      expect(queue.added).toHaveLength(1);
    });
  });
});
