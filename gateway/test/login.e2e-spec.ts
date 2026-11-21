import { afterEach, beforeAll, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { PasswordHasher } from '../src/users/password-hasher.js';
import { stubEnv } from './app-helpers.js';
import { TEST_ORIGIN, bearer } from './auth-helpers.js';
import {
  EMAIL,
  OTHER_PASSWORD,
  PASSWORD,
  cookieOf,
  login,
  startLoginApp,
  tokenOf,
  withCookie,
  type LoginApp,
} from './login-helpers.js';
import { FakeJob } from './fake-queue.js';

/**
 * Reviewer login through the real HTTP stack with in-memory sessions, counters and users (no Redis or
 * Postgres needed) and a clock the test moves. The real-infrastructure versions are in
 * sessions.pg.e2e-spec.ts.
 */
describe('reviewer login, sessions and cookie auth (in-memory infrastructure)', () => {
  let world: LoginApp;

  beforeAll(() => stubEnv());
  afterEach(async () => {
    vi.restoreAllMocks();
    await world?.app.close();
  });

  const logIn = async () => {
    const response = await login(world).expect(200);
    return { response, cookie: cookieOf(response) as string };
  };

  describe('POST /auth/login', () => {
    it('200 with the user and expires_at, and a session cookie with the right attributes', async () => {
      world = await startLoginApp();
      const response = await login(world).expect(200);

      expect(response.body).toEqual({
        user: { id: world.ada.id, email: EMAIL, display_name: 'Ada Lovelace', role: 'reviewer' },
        expires_at: new Date(world.clock.now + 3600_000).toISOString(), // idle timeout (60 min) comes before the 8 h limit
      });
      const cookie = (response.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('tiq_session=')) as string;
      const parts = cookie.split('; ');
      expect(parts[0]).toMatch(/^tiq_session=[A-Za-z0-9_-]{43}$/);
      expect(parts).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=28800']));
      expect(parts.filter((p) => /^domain=/i.test(p))).toEqual([]);
    });

    it('the body never contains a password, a hash or the token', async () => {
      world = await startLoginApp();
      const response = await login(world).expect(200);
      const text = JSON.stringify(response.body);
      expect(text).not.toMatch(/argon2|password|hash/i);
      expect(text).not.toContain(tokenOf(cookieOf(response) as string));
    });

    it('the email is matched in any capitalisation and with spaces around it', async () => {
      world = await startLoginApp();
      await login(world, { email: '  ADA@Example.COM ', password: PASSWORD }).expect(200);
    });

    it('wrong password, unknown email and disabled user give BYTE-IDENTICAL 401 answers', async () => {
      world = await startLoginApp();
      const wrong = await login(world, { email: EMAIL, password: OTHER_PASSWORD }).expect(401);
      const unknown = await login(world, { email: 'nobody@example.com', password: PASSWORD }).expect(401);
      const disabled = await login(world, { email: 'off@example.com', password: PASSWORD }).expect(401);

      for (const response of [wrong, unknown, disabled]) {
        expect(response.text).toBe('{"message":"Invalid email or password"}');
        expect(response.headers['set-cookie']).toBeUndefined();
      }
      expect(wrong.status).toBe(unknown.status);
      expect(unknown.text).toBe(disabled.text);
      const names = (r: typeof wrong) => Object.keys(r.headers).filter((h) => !['date', 'etag', 'x-ratelimit'].includes(h)).sort((a, b) => a.localeCompare(b));
      expect(names(wrong)).toEqual(names(unknown));
      expect(names(unknown)).toEqual(names(disabled));
    });

    it('every failure path verifies a password (constant work), including the unknown-email one', async () => {
      world = await startLoginApp();
      await login(world, { email: 'nobody@example.com', password: PASSWORD });
      await login(world, { email: 'off@example.com', password: PASSWORD });
      await login(world, { email: EMAIL, password: OTHER_PASSWORD });
      expect(world.verify).toHaveBeenCalledTimes(3);
    });

    it.each([
      [{}],
      [{ email: EMAIL }],
      [{ password: PASSWORD }],
      [{ email: EMAIL, password: PASSWORD, remember: true }],
      [{ email: 'e'.repeat(255), password: PASSWORD }],
      [{ email: EMAIL, password: 'p'.repeat(129) }],
      [{ email: 5, password: PASSWORD }],
    ])('an invalid body %j -> 400 {message}, nothing is echoed, no session', async (body) => {
      world = await startLoginApp();
      const response = await login(world, body as Record<string, unknown>).expect(400);
      expect(response.body).toEqual({ message: 'Invalid login request' });
      expect(response.headers['set-cookie']).toBeUndefined();
    });

    it('a non-JSON content type -> 415', async () => {
      world = await startLoginApp();
      await world.http().post('/auth/login').set('Origin', TEST_ORIGIN).set('Content-Type', 'text/plain').send('x').expect(415);
    });

    it('a failed login creates no session', async () => {
      world = await startLoginApp();
      await login(world, { email: EMAIL, password: OTHER_PASSWORD }).expect(401);
      expect(world.sessionStore.entries.size).toBe(0);
    });
  });

  describe('Origin check on login and logout', () => {
    it.each([
      ['missing', null],
      ['another site', 'http://evil.example.com'],
      ['the right host, wrong port', 'http://localhost:5174'],
      ['null', 'null'],
    ])('login with an Origin that is %s -> 403, and no password is even checked', async (_label, origin) => {
      world = await startLoginApp();
      const response = await login(world, undefined, { origin }).expect(403);
      expect(response.body).toEqual({ message: 'Origin not allowed' });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(world.verify).not.toHaveBeenCalled();
    });

    it('logout with a missing or wrong Origin -> 403 and the session survives', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      await world.http().post('/auth/logout').set('Cookie', cookie).expect(403);
      await world.http().post('/auth/logout').set('Cookie', cookie).set('Origin', 'http://evil.example.com').expect(403);
      await withCookie(world, cookie).get('/auth/me').expect(200);
    });
  });

  describe('GET /auth/me', () => {
    it('200 with the same user and expires_at for a valid session', async () => {
      world = await startLoginApp();
      const { response, cookie } = await logIn();
      const me = await withCookie(world, cookie).get('/auth/me').expect(200);
      expect(me.body).toEqual({
        user: { id: world.ada.id, email: EMAIL, display_name: 'Ada Lovelace', role: 'reviewer' },
        expires_at: response.body.expires_at,
      });
    });

    it('401 without a cookie, with a garbage cookie, and with an unknown well-formed token', async () => {
      world = await startLoginApp();
      await world.http().get('/auth/me').expect(401);
      await world.http().get('/auth/me').set('Cookie', 'tiq_session=garbage').expect(401);
      await world.http().get('/auth/me').set('Cookie', `tiq_session=${'a'.repeat(43)}`).expect(401);
    });

    it('401 for an API-key caller (a key is not a session)', async () => {
      world = await startLoginApp();
      await world.http().get('/auth/me').set('Authorization', bearer('ops')).expect(401);
    });
  });

  describe('a session cookie gives a reviewer exactly a reviewer\'s access', () => {
    it('GET /tickets (forwarded to Python) works with the cookie, like a reviewer key', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      const byCookie = await withCookie(world, cookie).get('/tickets').expect(200);
      const byKey = await world.http().get('/tickets').set('Authorization', bearer('ops')).expect(200);
      expect(byCookie.body).toEqual(byKey.body);
    });

    it('the dead-letter routes work with the cookie', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      await withCookie(world, cookie).get('/dead-letters').expect(200);
      await withCookie(world, cookie).post('/dead-letters/00000000-0000-4000-8000-000000000000/retry').expect(404); // allowed in; no such job
    });

    it('POST /tickets (a submitter-style route) works with the cookie and the Origin, answering like a reviewer key; the job is owned by the user', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      const body = { subject: 'Cannot log in', body: 'I forgot my password.' };
      const byCookie = await withCookie(world, cookie).post('/tickets').send(body).expect(202);
      const byKey = await world.http().post('/tickets').set('Authorization', bearer('ops')).send(body).expect(202);

      expect(Object.keys(byCookie.body).sort((a, b) => a.localeCompare(b))).toEqual(Object.keys(byKey.body).sort((a, b) => a.localeCompare(b)));
      expect(world.queue.added[0].data.client).toBe(`user:${world.ada.id}`);
      expect(world.queue.added[1].data.client).toBe('ops'); // a client keeps its bare name
    });

    it('GET /jobs/:id: a reviewer user reads any job, like a reviewer key', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      world.queue.jobs.set('00000000-0000-4000-8000-000000000001', new FakeJob({ subject: 's', body: 'b', received_at: 'r', client: 'alice' }, 'waiting'));
      await withCookie(world, cookie).get('/jobs/00000000-0000-4000-8000-000000000001').expect(200);
    });

    it('no credentials -> 401 with the usual body', async () => {
      world = await startLoginApp();
      const response = await world.http().get('/tickets').expect(401);
      expect(response.body).toEqual({ detail: 'Missing or invalid API key' });
    });

    it('a cookie-authenticated write needs the Origin: missing or wrong -> 403, and Python is not contacted', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      const noOrigin = await withCookie(world, cookie).post('/tickets', null).send({ subject: 's', body: 'b' }).expect(403);
      expect(noOrigin.body).toEqual({ detail: 'Origin not allowed' });
      await withCookie(world, cookie).post('/tickets', 'http://evil.example.com').send({ subject: 's', body: 'b' }).expect(403);
      expect(world.queue.added).toHaveLength(0);
    });

    it('API-key writes need NO Origin', async () => {
      world = await startLoginApp();
      await world.http().post('/tickets').set('Authorization', bearer('alice')).send({ subject: 's', body: 'b' }).expect(202);
    });

    it('cookie GET needs no Origin', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      await withCookie(world, cookie).get('/tickets').expect(200);
    });
  });

  describe('one guard, two kinds of caller', () => {
    it('API key + cookie together: the KEY wins (a submitter key is refused the reviewer routes despite a reviewer cookie)', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      await world.http().get('/tickets').set('Cookie', cookie).set('Authorization', bearer('alice')).expect(403);
      await world.http().get('/tickets').set('Cookie', cookie).set('Authorization', bearer('ops')).expect(200);
    });

    it('a bad key with a good cookie is 401: no falling back to the cookie', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      await world.http().get('/tickets').set('Cookie', cookie).set('Authorization', 'Bearer tiq_wrong').expect(401);
    });

    it('API key + cookie on /auth/me: the key is not a session, so 401', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      await world.http().get('/auth/me').set('Cookie', cookie).set('Authorization', bearer('ops')).expect(401);
    });

    it('the rate-limit bucket of a user is separate from every client\'s ("user:<uuid>" vs "client:<name>")', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      await withCookie(world, cookie).get('/auth/me').expect(200);
      await world.http().get('/auth/me').set('Authorization', bearer('ops')); // a client call
      const keys = [...world.queue.kv.counters.keys()].sort((a, b) => a.localeCompare(b));
      expect(keys).toEqual([`rl:client:ops`, `rl:user:${world.ada.id}`]);
    });

    it('rate-limit headers are on cookie-authenticated answers too', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      const me = await withCookie(world, cookie).get('/auth/me').expect(200);
      expect(me.headers['ratelimit-limit']).toBe('10000');
      expect(me.headers['ratelimit-remaining']).toBe('9999');
    });
  });

  describe('existing client-owned jobs keep working (no migration)', () => {
    it('alice sees her job, bob gets 404, a reviewer user sees it; a user-owned job is 404 to a submitter', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      const id = '00000000-0000-4000-8000-0000000000aa';
      // exactly what jobs created before M4.1b hold: the bare client name
      world.queue.jobs.set(id, new FakeJob({ subject: 's', body: 'b', received_at: 'r', client: 'alice' }, 'waiting'));
      await world.http().get(`/jobs/${id}`).set('Authorization', bearer('alice')).expect(200);
      await world.http().get(`/jobs/${id}`).set('Authorization', bearer('bob')).expect(404);
      await withCookie(world, cookie).get(`/jobs/${id}`).expect(200);

      const posted = await withCookie(world, cookie).post('/tickets').send({ subject: 's', body: 'b' }).expect(202);
      await world.http().get(posted.body.status_url).set('Authorization', bearer('alice')).expect(404); // not hers
    });

    it('a client whose name looks like a user\'s owner string cannot be built: names never contain ":"', async () => {
      world = await startLoginApp();
      // alice's bare name is not "user:<uuid>", so she cannot see a user-owned job
      const { cookie } = await logIn();
      const posted = await withCookie(world, cookie).post('/tickets').send({ subject: 's', body: 'b' }).expect(202);
      await world.http().get(posted.body.status_url).set('Authorization', bearer('alice')).expect(404);
    });
  });

  describe('POST /auth/logout', () => {
    it('204, clears the cookie (same attributes, expired), and the session is gone', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      const out = await withCookie(world, cookie).post('/auth/logout').expect(204);

      const cleared = (out.headers['set-cookie'] as unknown as string[])[0].split('; ');
      expect(cleared[0]).toBe('tiq_session=');
      expect(cleared).toEqual(expect.arrayContaining(['Max-Age=0', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT']));
      expect(out.text).toBe('');
      await withCookie(world, cookie).get('/auth/me').expect(401); // the OLD cookie is dead server-side
      expect(world.sessionStore.entries.size).toBe(0);
    });

    it('is idempotent: twice, without a cookie, with garbage, with an expired session: all 204', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      await withCookie(world, cookie).post('/auth/logout').expect(204);
      await withCookie(world, cookie).post('/auth/logout').expect(204);
      await world.http().post('/auth/logout').set('Origin', TEST_ORIGIN).expect(204);
      await withCookie(world, 'tiq_session=garbage').post('/auth/logout').expect(204);

      const second = await logIn();
      world.clock.advanceSeconds(3 * 3600); // long past the idle timeout
      await withCookie(world, second.cookie).post('/auth/logout').expect(204);
    });

    it('always clears the cookie, even with no session to end', async () => {
      world = await startLoginApp();
      const out = await world.http().post('/auth/logout').set('Origin', TEST_ORIGIN).expect(204);
      expect((out.headers['set-cookie'] as unknown as string[])[0]).toContain('Max-Age=0');
    });

    it('logging out one session leaves the user\'s other sessions alone', async () => {
      world = await startLoginApp();
      const a = await logIn();
      const b = await logIn();
      await withCookie(world, a.cookie).post('/auth/logout').expect(204);
      await withCookie(world, b.cookie).get('/auth/me').expect(200);
    });
  });

  describe('session fixation', () => {
    it('an old session cookie sent with a login is dead afterwards, and the new token is different', async () => {
      world = await startLoginApp();
      const first = await logIn();
      const second = await login(world, undefined, { cookie: first.cookie }).expect(200);
      const secondCookie = cookieOf(second) as string;

      expect(secondCookie).not.toBe(first.cookie);
      await withCookie(world, first.cookie).get('/auth/me').expect(401);
      await withCookie(world, secondCookie).get('/auth/me').expect(200);
    });

    it('a token chosen by someone else (never issued) is never accepted: login always issues its own', async () => {
      world = await startLoginApp();
      const planted = `tiq_session=${'P'.repeat(43)}`;
      const response = await login(world, undefined, { cookie: planted }).expect(200);
      expect(tokenOf(cookieOf(response) as string)).not.toBe('P'.repeat(43));
      await withCookie(world, planted).get('/auth/me').expect(401);
    });
  });

  describe('lifetimes', () => {
    it('idle expiry: a session unused for 60 minutes is gone', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      world.clock.advanceSeconds(59 * 60);
      await withCookie(world, cookie).get('/auth/me').expect(200); // this use slides it
      world.clock.advanceSeconds(61 * 60);
      await withCookie(world, cookie).get('/auth/me').expect(401);
    });

    it('use keeps a session alive; absolute expiry (8 hours) ends it however busy it is', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      for (let i = 0; i < 15; i += 1) {
        world.clock.advanceSeconds(30 * 60);
        await withCookie(world, cookie).get('/auth/me').expect(200);
      }
      world.clock.advanceSeconds(30 * 60); // exactly 8 hours after login
      await withCookie(world, cookie).get('/auth/me').expect(401);
    });

    it('expires_at in /auth/me follows the slide, but never goes past the absolute limit', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      world.clock.advanceSeconds(10 * 60);
      const me = await withCookie(world, cookie).get('/auth/me').expect(200);
      expect(me.body.expires_at).toBe(new Date(world.clock.now + 3600_000).toISOString());
      for (let i = 0; i < 14; i += 1) {
        world.clock.advanceSeconds(30 * 60);
        await withCookie(world, cookie).get('/auth/me');
      }
      const late = await withCookie(world, cookie).get('/auth/me').expect(200);
      expect(Date.parse(late.body.expires_at)).toBeLessThanOrEqual(world.clock.now + 3600_000);
      expect(late.body.expires_at).toBe(new Date(Date.parse('2026-11-21T12:00:00.000Z') + 8 * 3600_000).toISOString());
    });

    it('the idle slide writes to the store at most once a minute, however many requests', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      world.clock.advanceSeconds(120);
      for (let i = 0; i < 30; i += 1) await withCookie(world, cookie).get('/auth/me').expect(200);
      expect(world.sessionStore.writes.touch).toBe(1);
    });
  });

  describe('the per-request user check (the authoritative one)', () => {
    it('a user disabled after login is refused on the next request, and the session is deleted', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      await withCookie(world, cookie).get('/tickets').expect(200);
      world.users.disable(world.ada.id);
      await withCookie(world, cookie).get('/tickets').expect(401);
      expect(world.sessionStore.entries.size).toBe(0);
    });

    it('a password changed after login ends the session even though nothing revoked it', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      world.clock.advanceSeconds(30);
      world.users.changePassword(world.ada.id, world.hash);
      expect(world.sessionStore.entries.size).toBe(1); // the session is still in the store ...
      await withCookie(world, cookie).get('/auth/me').expect(401); // ... but is refused
    });

    it('a session created after the password change is fine', async () => {
      world = await startLoginApp();
      world.users.changePassword(world.ada.id, world.hash);
      world.clock.advanceSeconds(5);
      const { cookie } = await logIn();
      await withCookie(world, cookie).get('/auth/me').expect(200);
    });

    it('a deleted user is refused', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      world.users.rows.delete(world.ada.id);
      await withCookie(world, cookie).get('/auth/me').expect(401);
    });

    it('with Postgres or Redis unavailable the check fails CLOSED with a 503, not an open door', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      world.users.findById = async () => {
        throw Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), { code: 'ECONNREFUSED' });
      };
      const response = await withCookie(world, cookie).get('/tickets').expect(503);
      expect(JSON.stringify(response.body)).not.toMatch(/10\.1\.2\.3|ECONNREFUSED/);
    });
  });

  describe('login failure limits', () => {
    it('per email: five failures, then the sixth attempt gets 429 with Retry-After, even with the RIGHT password', async () => {
      world = await startLoginApp();
      for (let i = 0; i < 5; i += 1) await login(world, { email: EMAIL, password: `wrong password number ${i}` }).expect(401);
      world.verify.mockClear();

      const limited = await login(world, { email: EMAIL, password: PASSWORD }).expect(429);

      expect(limited.body).toEqual({ message: 'Too many failed attempts. Try again later.' });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(900);
      expect(limited.headers['set-cookie']).toBeUndefined();
      expect(world.verify).not.toHaveBeenCalled(); // a limited request costs no Argon2 work
    });

    it('per IP: twenty failures across different emails, then 429', async () => {
      world = await startLoginApp();
      for (let i = 0; i < 20; i += 1) await login(world, { email: `user${i}@example.com`, password: PASSWORD }).expect(401);
      world.verify.mockClear();
      const limited = await login(world, { email: 'someone.new@example.com', password: PASSWORD }).expect(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(world.verify).not.toHaveBeenCalled();
    });

    it('X-Forwarded-For is IGNORED unless TRUST_PROXY is on: a caller cannot pick its own IP', async () => {
      world = await startLoginApp();
      for (let i = 0; i < 20; i += 1) {
        await login(world, { email: `user${i}@example.com`, password: PASSWORD }, { forwardedFor: `198.51.100.${i}` }).expect(401);
      }
      await login(world, { email: 'someone.new@example.com', password: PASSWORD }, { forwardedFor: '203.0.113.99' }).expect(429);
    });

    it('a successful login clears the email counter', async () => {
      world = await startLoginApp();
      for (let i = 0; i < 4; i += 1) await login(world, { email: EMAIL, password: `wrong password number ${i}` }).expect(401);
      await login(world).expect(200); // success resets
      for (let i = 0; i < 4; i += 1) await login(world, { email: EMAIL, password: `another wrong number ${i}` }).expect(401);
      await login(world).expect(200); // would have been the 9th failure-or-attempt without the reset
    });

    it('after the window (15 minutes) logins work again', async () => {
      world = await startLoginApp();
      for (let i = 0; i < 5; i += 1) await login(world, { email: EMAIL, password: `wrong password number ${i}` });
      await login(world).expect(429);
      world.clock.advanceSeconds(15 * 60 + 1);
      await login(world).expect(200);
    });

    it('the counters live under the SHA-256 of the email, never the email', async () => {
      world = await startLoginApp();
      await login(world, { email: 'Secret.Person@Example.com', password: 'whatever whatever' }).expect(401);
      const keys = [...world.counters.entries.keys()].join(' ');
      expect(keys).not.toMatch(/secret|person|example/i);
      expect(keys).toMatch(/login_fail:email:[0-9a-f]{64}/);
    });

    it('Redis (the counters) unavailable -> 503, no session, and no password was checked', async () => {
      world = await startLoginApp();
      world.counters.read = async () => {
        throw Object.assign(new Error('Connection is closed.'), { code: 'ECONNRESET' });
      };
      const response = await login(world).expect(503);
      expect(response.body).toEqual({ message: 'Login is temporarily unavailable; please retry' });
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(world.verify).not.toHaveBeenCalled();
    });
  });

  describe('what is stored and logged', () => {
    it('the store holds the SHA-256 of the token, never the token or the email', async () => {
      world = await startLoginApp();
      const { cookie } = await logIn();
      const token = tokenOf(cookie);
      const stored = JSON.stringify([...world.sessionStore.entries.entries()]);
      expect(stored).not.toContain(token);
      expect(stored).not.toContain(EMAIL);
      expect([...world.sessionStore.entries.keys()][0]).toMatch(/^[0-9a-f]{64}$/);
    });

    it('login and request logs never contain the email, password, cookie or token', async () => {
      const lines: string[] = [];
      for (const method of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
        vi.spyOn(Logger.prototype, method).mockImplementation((m: unknown) => void lines.push(String(m)));
      }
      world = await startLoginApp();
      const { cookie } = await logIn();
      await login(world, { email: EMAIL, password: 'a wrong typed password' }).expect(401);
      await login(world, { email: 'my-password-in-the-email-box', password: PASSWORD }).expect(401);
      await withCookie(world, cookie).get('/tickets').expect(200);
      await withCookie(world, cookie).post('/auth/logout').expect(204);

      const text = lines.join('\n');
      expect(text).not.toContain(EMAIL);
      expect(text).not.toContain('my-password-in-the-email-box');
      expect(text).not.toContain(PASSWORD);
      expect(text).not.toContain('a wrong typed password');
      expect(text).not.toContain(tokenOf(cookie));
      expect(text).not.toMatch(/tiq_session|argon2/);
    });
  });

  it('the responses carry the security headers and no X-Powered-By', async () => {
    world = await startLoginApp();
    const response = await login(world).expect(200);
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('there is no sign-up endpoint', async () => {
    world = await startLoginApp();
    await world.http().post('/auth/register').set('Origin', TEST_ORIGIN).send({ email: 'x@y.co', password: PASSWORD }).expect(404);
    await world.http().post('/auth/signup').set('Origin', TEST_ORIGIN).send({ email: 'x@y.co', password: PASSWORD }).expect(404);
  });

  it('PasswordHasher is the real one (the tests exercise real Argon2)', async () => {
    world = await startLoginApp();
    expect(world.app.get(PasswordHasher, { strict: false })).toBeInstanceOf(PasswordHasher);
  });
});
