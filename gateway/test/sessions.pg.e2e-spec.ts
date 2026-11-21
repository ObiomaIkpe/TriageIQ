import { createHash } from 'node:crypto';
import { hash as argonHash } from '@node-rs/argon2';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import type pg from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { FETCH } from '../src/health/health.constants.js';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/database/migrate.js';
import { createPool } from '../src/database/pool.js';
import { runReviewers, type CliDeps } from '../src/scripts/reviewers.js';
import { revokeUserSessions } from '../src/sessions/session.store.js';
import { PasswordHasher } from '../src/users/password-hasher.js';
import { UsersRepository } from '../src/users/users.repository.js';
import { WorkerModule } from '../src/worker/worker.module.js';
import { NoWorkerModule, stubEnv } from './app-helpers.js';
import { TEST_ORIGIN, bearer } from './auth-helpers.js';
import { fakeFetch, OTHER_PASSWORD, PASSWORD } from './login-helpers.js';

/**
 * Reviewer login against a REAL Redis and a REAL Postgres: the real Lua scripts, real TTLs, the real
 * migrations and users table, and the reviewer CLI. Skipped unless BOTH are available:
 *   REDIS_TEST_URL=redis://localhost:6390
 *   GATEWAY_TEST_DATABASE_URL=postgresql://user:pw@localhost:5441/gateway_test   (name must end in _test)
 * It deletes the session, index and login-failure keys it creates and never flushes the database.
 */
const REDIS_URL = process.env.REDIS_TEST_URL;
const PG_URL = process.env.GATEWAY_TEST_DATABASE_URL;

if (PG_URL && !/\/[^/?]*_test(\?.*)?$/.test(PG_URL)) {
  throw new Error('GATEWAY_TEST_DATABASE_URL must name a database whose name ends in _test');
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const EMAIL = 'ada@example.com';
const OWN_PATTERNS = ['session:*', 'user_sessions:*', 'login_fail:*'];

describe.skipIf(!REDIS_URL || !PG_URL)('reviewer login against real Redis and Postgres', () => {
  let app: NestExpressApplication;
  let pool: pg.Pool;
  let redis: Redis;
  let users: UsersRepository;
  const hasher = new PasswordHasher();
  let adaId: string;
  let offId: string;

  const http = () => request(app.getHttpServer());
  const login = (body: Record<string, unknown> = { email: EMAIL, password: PASSWORD }, extra: { origin?: string | null; cookie?: string } = {}) => {
    const req = http().post('/auth/login').set('Content-Type', 'application/json');
    if (extra.origin !== null) req.set('Origin', extra.origin ?? TEST_ORIGIN);
    if (extra.cookie) req.set('Cookie', extra.cookie);
    return req.send(body);
  };
  const cookieOf = (res: { headers: Record<string, unknown> }) =>
    (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('tiq_session='))?.split(';')[0] as string;
  const tokenOf = (cookie: string) => cookie.slice('tiq_session='.length);
  const authed = (cookie: string) => ({
    get: (url: string) => http().get(url).set('Cookie', cookie),
    post: (url: string, origin: string | null = TEST_ORIGIN) => {
      const req = http().post(url).set('Cookie', cookie);
      if (origin !== null) req.set('Origin', origin);
      return req;
    },
  });
  const logIn = async () => cookieOf(await login().expect(200));

  const ownKeys = async () => (await Promise.all(OWN_PATTERNS.map((p) => redis.keys(p)))).flat();
  const clearOwnKeys = async () => {
    const keys = await ownKeys();
    if (keys.length > 0) await redis.del(...keys);
  };

  beforeAll(async () => {
    stubEnv(REDIS_URL);
    vi.stubEnv('GATEWAY_DATABASE_URL', PG_URL as string);
    const { AppModule } = await import('../src/app.module.js');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideModule(WorkerModule)
      .useModule(NoWorkerModule)
      .overrideProvider(FETCH)
      .useValue(fakeFetch)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureApp(app);
    await app.init();
    pool = createPool(PG_URL as string, { statementTimeoutMs: 0, max: 4 });
    redis = new Redis(REDIS_URL as string);
    users = new UsersRepository(pool);
  });

  afterAll(async () => {
    await clearOwnKeys();
    redis?.disconnect();
    await pool?.end();
    await app?.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migrate(pool, DEFAULT_MIGRATIONS_DIR);
    await clearOwnKeys();
    const passwordHash = await hasher.hash(PASSWORD);
    adaId = (await users.create({ email: EMAIL, displayName: 'Ada Lovelace', passwordHash })).id;
    offId = (await users.create({ email: 'off@example.com', displayName: 'Off', passwordHash })).id;
    await users.setDisabled('off@example.com', true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearOwnKeys();
  });

  /** The CLI, wired to the real database and (optionally) the real Redis. */
  const cli = (argv: string[], over: Partial<CliDeps> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: CliDeps = {
      users,
      hasher,
      sessions: { revokeAll: (id) => revokeUserSessions(redis, id) },
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
      askPassword: async () => OTHER_PASSWORD,
      interactive: false,
      ...over,
    };
    return runReviewers(argv, deps).then((code) => ({ code, out, err }));
  };

  describe('what login stores in Redis', () => {
    it('sets the cookie, stores the session under the SHA-256 of the token, and indexes it by user', async () => {
      const response = await login().expect(200);
      const cookie = cookieOf(response);
      const token = tokenOf(cookie);
      const hash = sha256(token);
      const parts = (response.headers['set-cookie'] as unknown as string[])[0].split('; ');
      expect(parts).toEqual(expect.arrayContaining(['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=28800']));

      const record = JSON.parse((await redis.get(`session:${hash}`)) as string) as Record<string, string>;
      expect(Object.keys(record).sort((a, b) => a.localeCompare(b))).toEqual(['created_at', 'last_seen_at', 'user_id']);
      expect(record.user_id).toBe(adaId);
      expect(await redis.sismember(`user_sessions:${adaId}`, hash)).toBe(1);
      const ttl = await redis.ttl(`session:${hash}`);
      expect(ttl).toBeGreaterThan(3590);
      expect(ttl).toBeLessThanOrEqual(3600); // the idle timeout
      expect(await redis.ttl(`user_sessions:${adaId}`)).toBeGreaterThan(28790); // the absolute lifetime
    });

    it('no key or value anywhere in Redis holds a raw token or a raw email (also after failed logins)', async () => {
      const cookie = await logIn();
      await login({ email: 'Secret.Person@Example.com', password: 'wrong wrong wrong' }).expect(401);
      await login({ email: EMAIL, password: 'wrong wrong wrong' }).expect(401);
      const everything: string[] = [];
      for (const key of await ownKeys()) {
        everything.push(key);
        const type = await redis.type(key);
        if (type === 'string') everything.push((await redis.get(key)) as string);
        if (type === 'set') everything.push(...(await redis.smembers(key)));
      }
      const text = everything.join('\n');
      expect(text).not.toContain(tokenOf(cookie));
      expect(text.toLowerCase()).not.toContain('example.com');
      expect(text.toLowerCase()).not.toContain('secret.person');
      expect(text).toContain(sha256(tokenOf(cookie)));
      expect(text).toContain(`login_fail:email:${sha256('secret.person@example.com')}`);
    });
  });

  describe('using the cookie', () => {
    it('/auth/me, GET /tickets and the dead-letter routes work with the cookie', async () => {
      const cookie = await logIn();
      const me = await authed(cookie).get('/auth/me').expect(200);
      expect(me.body.user).toEqual({ id: adaId, email: EMAIL, display_name: 'Ada Lovelace', role: 'reviewer' });
      await authed(cookie).get('/tickets').expect(200);
      await authed(cookie).get('/dead-letters').expect(200);
    });

    it('wrong password, unknown email and disabled user: identical 401 bodies', async () => {
      const bodies = [
        (await login({ email: EMAIL, password: OTHER_PASSWORD }).expect(401)).text,
        (await login({ email: 'nobody@example.com', password: PASSWORD }).expect(401)).text,
        (await login({ email: 'off@example.com', password: PASSWORD }).expect(401)).text,
      ];
      expect(new Set(bodies).size).toBe(1);
      expect(bodies[0]).toBe('{"message":"Invalid email or password"}');
    });

    it('missing or wrong Origin -> 403 on login, logout and a cookie POST; a key needs none; key + cookie -> the key wins', async () => {
      const cookie = await logIn();
      await login(undefined, { origin: null }).expect(403);
      await login(undefined, { origin: 'http://evil.example.com' }).expect(403);
      await http().post('/auth/logout').set('Cookie', cookie).expect(403);
      await authed(cookie).post('/tickets', null).send({ subject: 's', body: 'b' }).expect(403);
      await http().post('/tickets').set('Authorization', bearer('alice')).send({ subject: 's', body: 'b' }).expect(202);
      await http().get('/tickets').set('Cookie', cookie).set('Authorization', bearer('alice')).expect(403); // alice is a submitter
    });

    it('existing client-owned jobs: alice sees hers, bob gets 404, a reviewer user sees it; user-owned jobs are 404 to alice', async () => {
      const cookie = await logIn();
      const aliceJob = await http().post('/tickets').set('Authorization', bearer('alice')).send({ subject: 'mine', body: 'b' }).expect(202);
      await http().get(aliceJob.body.status_url).set('Authorization', bearer('alice')).expect(200);
      await http().get(aliceJob.body.status_url).set('Authorization', bearer('bob')).expect(404);
      await authed(cookie).get(aliceJob.body.status_url).expect(200);

      const userJob = await authed(cookie).post('/tickets').send({ subject: 'by a user', body: 'b' }).expect(202);
      await http().get(userJob.body.status_url).set('Authorization', bearer('alice')).expect(404);
      await authed(cookie).get(userJob.body.status_url).expect(200);
    });
  });

  describe('logout and fixation', () => {
    it('logout deletes the session and its index entry; the cookie is dead; logging out twice is 204', async () => {
      const cookie = await logIn();
      const hash = sha256(tokenOf(cookie));
      await authed(cookie).post('/auth/logout').expect(204);
      expect(await redis.exists(`session:${hash}`)).toBe(0);
      expect(await redis.sismember(`user_sessions:${adaId}`, hash)).toBe(0);
      await authed(cookie).get('/auth/me').expect(401);
      await authed(cookie).post('/auth/logout').expect(204);
    });

    it('an old cookie sent with a login is deleted from Redis, and a new session is created', async () => {
      const first = await logIn();
      const second = cookieOf(await login(undefined, { cookie: first }).expect(200));
      expect(second).not.toBe(first);
      expect(await redis.exists(`session:${sha256(tokenOf(first))}`)).toBe(0);
      expect(await redis.exists(`session:${sha256(tokenOf(second))}`)).toBe(1);
      await authed(first).get('/auth/me').expect(401);
    });
  });

  describe('expiry (real Redis TTLs)', () => {
    it('idle expiry: Redis removes the session when its TTL runs out', async () => {
      const cookie = await logIn();
      const key = `session:${sha256(tokenOf(cookie))}`;
      await redis.expire(key, 1); // as if the idle timeout were about to run out
      await new Promise((resolve) => setTimeout(resolve, 1300));
      await authed(cookie).get('/auth/me').expect(401);
    });

    it('absolute expiry: a session older than 8 hours is refused and deleted even if Redis still holds it', async () => {
      const cookie = await logIn();
      const key = `session:${sha256(tokenOf(cookie))}`;
      const record = JSON.parse((await redis.get(key)) as string) as Record<string, string>;
      record.created_at = new Date(Date.now() - 8 * 3600_000 - 5000).toISOString();
      await redis.set(key, JSON.stringify(record), 'EX', 3000);
      await authed(cookie).get('/auth/me').expect(401);
      expect(await redis.exists(key)).toBe(0);
    });

    it('the idle slide: a use more than a minute after the last write rewrites the TTL (real TOUCH script)', async () => {
      const cookie = await logIn();
      const key = `session:${sha256(tokenOf(cookie))}`;
      const record = JSON.parse((await redis.get(key)) as string) as Record<string, string>;
      record.last_seen_at = new Date(Date.now() - 120_000).toISOString();
      await redis.set(key, JSON.stringify(record), 'EX', 100); // the TTL has run down to 100 s
      await authed(cookie).get('/auth/me').expect(200);
      expect(await redis.ttl(key)).toBeGreaterThan(3500); // slid back to the idle timeout
      const after = JSON.parse((await redis.get(key)) as string) as Record<string, string>;
      expect(Date.parse(after.last_seen_at)).toBeGreaterThan(Date.now() - 5000);
      expect(after.created_at).toBe(record.created_at); // created_at never moves
    });

    it('a use within a minute does NOT write (the TTL is left alone)', async () => {
      const cookie = await logIn();
      const key = `session:${sha256(tokenOf(cookie))}`;
      await redis.expire(key, 1000);
      await authed(cookie).get('/auth/me').expect(200);
      expect(await redis.ttl(key)).toBeLessThanOrEqual(1000);
    });
  });

  describe('the reviewer CLI revokes sessions', () => {
    it('disable ends every session of the user, says how many, and the old cookie is refused', async () => {
      const a = await logIn();
      const b = await logIn();
      const { code, out } = await cli(['disable', '--email', EMAIL]);
      expect(code).toBe(0);
      expect(out).toEqual([`Disabled ${EMAIL}.`, `Ended 2 sessions for ${EMAIL}.`]);
      expect(await redis.exists(`user_sessions:${adaId}`)).toBe(0);
      await authed(a).get('/auth/me').expect(401);
      await authed(b).get('/auth/me').expect(401);
      await login().expect(401); // and a new login is refused: disabled
    });

    it('set-password ends old sessions; login with the NEW password works and the OLD one does not', async () => {
      const old = await logIn();
      const { code, out } = await cli(['set-password', '--email', EMAIL]); // the CLI "types" OTHER_PASSWORD
      expect(code).toBe(0);
      expect(out).toEqual([`Password changed for ${EMAIL}.`, `Ended 1 session for ${EMAIL}.`]);
      await authed(old).get('/auth/me').expect(401);
      await login({ email: EMAIL, password: PASSWORD }).expect(401);
      const fresh = cookieOf(await login({ email: EMAIL, password: OTHER_PASSWORD }).expect(200));
      await authed(fresh).get('/auth/me').expect(200);
    });

    it('does not touch other users\' sessions', async () => {
      const second = await users.create({ email: 'other@example.com', displayName: 'Other', passwordHash: await hasher.hash(PASSWORD) });
      const adaCookie = await logIn();
      const otherCookie = cookieOf(await login({ email: 'other@example.com', password: PASSWORD }).expect(200));
      await cli(['disable', '--email', EMAIL]);
      await authed(otherCookie).get('/auth/me').expect(200);
      await authed(adaCookie).get('/auth/me').expect(401);
      expect(second.id).toBeDefined();
    });

    it('with Redis unreachable at CLI time the database change still stands and a clear warning is printed', async () => {
      const failing = { revokeAll: async () => { throw Object.assign(new Error('connect ECONNREFUSED 10.9.9.9:6379'), { code: 'ECONNREFUSED' }); } };
      const { code, err } = await cli(['disable', '--email', EMAIL], { sessions: failing });
      expect(code).toBe(0);
      expect(err.join('')).toContain('Warning: could not end the sessions in Redis (ECONNREFUSED)');
      expect((await users.findByEmail(EMAIL))?.disabledAt).toBeInstanceOf(Date);
    });

    it('the per-request check holds even when the CLI revocation was skipped: disable', async () => {
      const cookie = await logIn();
      await cli(['disable', '--email', EMAIL], { sessions: { revokeAll: async () => { throw new Error('REDIS_URL is not set'); } } });
      expect(await ownKeys()).toContain(`session:${sha256(tokenOf(cookie))}`); // the session is still in Redis ...
      await authed(cookie).get('/auth/me').expect(401); // ... and is refused anyway
      expect(await redis.exists(`session:${sha256(tokenOf(cookie))}`)).toBe(0); // and deleted by that check
    });

    it('the per-request check holds even when the CLI revocation was skipped: set-password (password_changed_at)', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30)); // the change must be later than the login
      const cookie = await logIn();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await cli(['set-password', '--email', EMAIL], { sessions: { revokeAll: async () => { throw new Error('timeout'); } } });
      expect(await redis.exists(`session:${sha256(tokenOf(cookie))}`)).toBe(1); // not revoked
      await authed(cookie).get('/auth/me').expect(401); // refused: password_changed_at is later than the session
    });
  });

  describe('failure limits (real Lua counters)', () => {
    it('per email: five failures, then 429 with Retry-After and no Argon2 work, even with the right password', async () => {
      for (let i = 0; i < 5; i += 1) await login({ email: EMAIL, password: `wrong password number ${i}` }).expect(401);
      const verify = vi.spyOn(app.get(PasswordHasher, { strict: false }), 'verify');
      const limited = await login().expect(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(900);
      expect(verify).not.toHaveBeenCalled();
      expect(await redis.ttl(`login_fail:email:${sha256(EMAIL)}`)).toBeGreaterThan(0); // a real expiry: never counted forever
    });

    it('per IP: twenty failures across different emails, then 429', async () => {
      for (let i = 0; i < 20; i += 1) await login({ email: `user${i}@example.com`, password: PASSWORD }).expect(401);
      const limited = await login({ email: 'new@example.com', password: PASSWORD }).expect(429);
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    });

    it('a success clears the email counter', async () => {
      for (let i = 0; i < 4; i += 1) await login({ email: EMAIL, password: `wrong password number ${i}` }).expect(401);
      expect(await redis.get(`login_fail:email:${sha256(EMAIL)}`)).toBe('4');
      await login().expect(200);
      expect(await redis.exists(`login_fail:email:${sha256(EMAIL)}`)).toBe(0);
    });

    it('concurrent failures are counted exactly (atomic INCR in Lua)', async () => {
      await Promise.all(Array.from({ length: 4 }, () => login({ email: EMAIL, password: 'wrong wrong wrong' })));
      expect(await redis.get(`login_fail:email:${sha256(EMAIL)}`)).toBe('4');
    });
  });

  describe('rehash on login', () => {
    it('a hash made with older parameters is upgraded, password_changed_at is untouched, and sessions stay valid', async () => {
      const old = await argonHash(PASSWORD, { algorithm: 2, memoryCost: 19456, timeCost: 3, parallelism: 1 });
      await pool.query('UPDATE users SET password_hash = $2 WHERE id = $1', [adaId, old]);
      const before = (await users.findByEmail(EMAIL))!;

      const cookie = cookieOf(await login().expect(200));

      const after = (await users.findByEmail(EMAIL))!;
      expect(after.passwordHash).not.toBe(old);
      expect(hasher.needsRehash(after.passwordHash)).toBe(false);
      expect(await hasher.verify(after.passwordHash, PASSWORD)).toBe(true);
      expect(after.passwordChangedAt.getTime()).toBe(before.passwordChangedAt.getTime());
      await authed(cookie).get('/auth/me').expect(200);
    });
  });

  it('a disabled user cannot log in, and a user disabled while logged in is refused next request', async () => {
    await login({ email: 'off@example.com', password: PASSWORD }).expect(401);
    expect(offId).toBeDefined();
    const cookie = await logIn();
    await users.setDisabled(EMAIL, true); // no CLI, no revocation: only the database changed
    await authed(cookie).get('/tickets').expect(401);
  });
});
