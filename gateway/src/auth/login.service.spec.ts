import { Logger } from '@nestjs/common';
import { vi } from 'vitest';
import { FakeClock, MemoryCounterStore, MemorySessionStore, MemoryUsers } from '../../test/memory-stores.js';
import { SessionService } from '../sessions/session.service.js';
import { PasswordHasher } from '../users/password-hasher.js';
import type { UsersRepository } from '../users/users.repository.js';
import { LoginLimiter } from './login-limiter.js';
import { LoginService } from './login.service.js';

const PASSWORD = 'a long and unusual passphrase';
const IP = '203.0.113.7';
const EMAIL = 'Ada@Example.com';

const hasher = new PasswordHasher();
let GOOD_HASH: string;
beforeAll(async () => {
  GOOD_HASH = await hasher.hash(PASSWORD);
});

function setup(limits: Record<string, number> = {}) {
  const clock = new FakeClock();
  const users = new MemoryUsers(clock);
  const sessionStore = new MemorySessionStore(clock);
  const counters = new MemoryCounterStore(clock);
  const config = {
    get: (name: string) =>
      ({ SESSION_IDLE_MINUTES: 60, SESSION_ABSOLUTE_HOURS: 8, LOGIN_MAX_FAILURES_PER_IP: 20, LOGIN_MAX_FAILURES_PER_EMAIL: 5, LOGIN_WINDOW_MINUTES: 15, ...limits })[name],
  } as never;
  const sessions = new SessionService(sessionStore, config, clock.fn);
  const limiter = new LoginLimiter(counters, config);
  const verify = vi.spyOn(hasher, 'verify');
  const service = new LoginService(users as unknown as UsersRepository, hasher, sessions, limiter);
  const user = users.add({ email: 'ada@example.com', passwordHash: GOOD_HASH });
  return { clock, users, sessionStore, counters, sessions, limiter, service, user, verify };
}

const attempt = (over: Partial<{ email: string; password: string; ip: string; oldToken?: string }> = {}) => ({
  email: EMAIL,
  password: PASSWORD,
  ip: IP,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('LoginService: success', () => {
  it('returns the user (without a hash) and a NEW session, and the email is matched in any capitalisation', async () => {
    const { service, user } = setup();
    const outcome = await service.login(attempt({ email: '  ADA@example.COM ' }));
    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') return;
    expect(outcome.user).toMatchObject({ id: user.id, email: 'ada@example.com' });
    expect(outcome.user).not.toHaveProperty('passwordHash');
    expect(outcome.session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('every login makes a different session', async () => {
    const { service } = setup();
    const a = await service.login(attempt());
    const b = await service.login(attempt());
    if (a.kind !== 'success' || b.kind !== 'success') throw new Error('expected success');
    expect(a.session.token).not.toBe(b.session.token);
  });

  it('session fixation: an old session token sent with the login is ended, and the new one is different', async () => {
    const { service, sessions } = setup();
    const first = await service.login(attempt());
    if (first.kind !== 'success') throw new Error('expected success');
    const second = await service.login(attempt({ oldToken: first.session.token }));
    if (second.kind !== 'success') throw new Error('expected success');
    expect(await sessions.find(first.session.token)).toBeUndefined();
    expect(await sessions.find(second.session.token)).toBeDefined();
    expect(second.session.token).not.toBe(first.session.token);
  });

  it('a stale or garbage old token is harmless', async () => {
    const { service } = setup();
    expect((await service.login(attempt({ oldToken: 'garbage' }))).kind).toBe('success');
    expect((await service.login(attempt({ oldToken: 'a'.repeat(43) }))).kind).toBe('success');
  });

  it('clears the email\'s failure counter', async () => {
    const { service, counters } = setup();
    await service.login(attempt({ password: 'wrong password one' }));
    await service.login(attempt({ password: 'wrong password two' }));
    await service.login(attempt());
    const emailKeys = [...counters.entries.keys()].filter((k) => k.startsWith('login_fail:email:'));
    expect(emailKeys).toEqual([]);
    expect(counters.entries.has(`login_fail:ip:${IP}`)).toBe(true); // the IP counter stays
  });

  it('a hash made with older parameters is upgraded for the same password, WITHOUT touching password_changed_at', async () => {
    const { service, users, user, clock } = setup();
    // 19 MiB with t=3 instead of t=2: still verifies, but needs a rehash
    const { hash } = await import('@node-rs/argon2');
    const old = await hash(PASSWORD, { algorithm: 2, memoryCost: 19456, timeCost: 3, parallelism: 1 });
    users.rows.get(user.id)!.passwordHash = old;
    const changedAt = users.rows.get(user.id)!.passwordChangedAt;
    clock.advanceSeconds(10);

    const outcome = await service.login(attempt());

    expect(outcome.kind).toBe('success');
    expect(users.rehashes).toHaveLength(1);
    expect(users.rehashes[0]).toMatchObject({ id: user.id, oldHash: old });
    expect(hasher.needsRehash(users.rows.get(user.id)!.passwordHash)).toBe(false);
    expect(users.rows.get(user.id)!.passwordChangedAt).toBe(changedAt); // sessions stay valid
    expect(await hasher.verify(users.rows.get(user.id)!.passwordHash, PASSWORD)).toBe(true);
  });

  it('a current hash is not rehashed', async () => {
    const { service, users } = setup();
    await service.login(attempt());
    expect(users.rehashes).toEqual([]);
  });

  it('a failed rehash does not fail the login', async () => {
    const { service, users, user } = setup();
    const { hash } = await import('@node-rs/argon2');
    users.rows.get(user.id)!.passwordHash = await hash(PASSWORD, { algorithm: 2, memoryCost: 19456, timeCost: 3, parallelism: 1 });
    users.rehashPassword = async () => {
      throw new Error('db down');
    };
    expect((await service.login(attempt())).kind).toBe('success');
  });
});

describe('LoginService: every failure looks the same and does the same work', () => {
  it.each([
    ['unknown email', { email: 'nobody@example.com' }],
    ['wrong password', { password: 'not the right passphrase' }],
  ])('%s -> invalid', async (_label, over) => {
    const { service } = setup();
    expect(await service.login(attempt(over))).toEqual({ kind: 'invalid' });
  });

  it('a disabled user with the RIGHT password -> invalid (and the password was still fully verified)', async () => {
    const { service, users, user, verify } = setup();
    users.disable(user.id);
    expect(await service.login(attempt())).toEqual({ kind: 'invalid' });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(user.passwordHash, PASSWORD);
  });

  it('the unknown-email path CALLS verify, against the dummy hash (constant work)', async () => {
    const { service, verify } = setup();
    await service.login(attempt({ email: 'nobody@example.com' }));
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(hasher.dummyHash, PASSWORD);
  });

  it('all failure paths verify exactly once', async () => {
    const { service, users, user, verify } = setup();
    users.add({ email: 'off@example.com', passwordHash: GOOD_HASH, disabled: true });
    await service.login(attempt({ email: 'nobody@example.com' }));
    await service.login(attempt({ password: 'wrong wrong wrong wrong' }));
    await service.login(attempt({ email: 'off@example.com' }));
    expect(verify).toHaveBeenCalledTimes(3);
    void user;
  });

  it('the outcome carries no reason: unknown, wrong and disabled are identical', async () => {
    const { service, users } = setup();
    users.add({ email: 'off@example.com', passwordHash: GOOD_HASH, disabled: true });
    const results = [
      await service.login(attempt({ email: 'nobody@example.com' })),
      await service.login(attempt({ password: 'wrong wrong wrong wrong' })),
      await service.login(attempt({ email: 'off@example.com' })),
    ];
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it('each failure is counted against the IP and the email hash; a disabled user\'s too', async () => {
    const { service, counters, users } = setup();
    users.add({ email: 'off@example.com', passwordHash: GOOD_HASH, disabled: true });
    await service.login(attempt({ email: 'nobody@example.com' }));
    await service.login(attempt({ email: 'off@example.com' }));
    expect(counters.count(`login_fail:ip:${IP}`)).toBe(2);
  });
});

describe('LoginService: limits come first and cost no Argon2 work', () => {
  it('a limited email -> limited with Retry-After, and verify is NOT called', async () => {
    const { service, verify } = setup({ LOGIN_MAX_FAILURES_PER_EMAIL: 3 });
    for (let i = 0; i < 3; i += 1) await service.login(attempt({ password: `wrong password number ${i}` }));
    verify.mockClear();
    const outcome = await service.login(attempt()); // even the RIGHT password is refused now
    expect(outcome).toMatchObject({ kind: 'limited' });
    expect((outcome as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    expect(verify).not.toHaveBeenCalled();
  });

  it('a limited IP -> limited, verify is NOT called, and the database is not even asked', async () => {
    const { service, verify, users } = setup({ LOGIN_MAX_FAILURES_PER_IP: 2 });
    await service.login(attempt({ email: 'x1@example.com' }));
    await service.login(attempt({ email: 'x2@example.com' }));
    verify.mockClear();
    users.lookups.byEmail = 0;
    expect((await service.login(attempt({ email: 'x3@example.com' }))).kind).toBe('limited');
    expect(verify).not.toHaveBeenCalled();
    expect(users.lookups.byEmail).toBe(0);
  });

  it('refused attempts do not extend the window: a flood cannot prolong its own lockout', async () => {
    const { service, counters, clock } = setup({ LOGIN_MAX_FAILURES_PER_EMAIL: 2 });
    for (let i = 0; i < 2; i += 1) await service.login(attempt({ password: `wrong password number ${i}` }));
    const expiries = () => [...counters.entries.entries()].map(([k, v]) => [k, v.expiresAt]);
    const before = expiries();
    clock.advanceSeconds(300);
    for (let i = 0; i < 10; i += 1) await service.login(attempt());
    expect(expiries()).toEqual(before);
  });

  it('after the window the right password works again', async () => {
    const { service, clock } = setup({ LOGIN_MAX_FAILURES_PER_EMAIL: 2 });
    for (let i = 0; i < 2; i += 1) await service.login(attempt({ password: `wrong password number ${i}` }));
    expect((await service.login(attempt())).kind).toBe('limited');
    clock.advanceSeconds(15 * 60 + 1);
    expect((await service.login(attempt())).kind).toBe('success');
  });

  it('only failures count: many successful logins never limit anyone', async () => {
    const { service } = setup({ LOGIN_MAX_FAILURES_PER_EMAIL: 2, LOGIN_MAX_FAILURES_PER_IP: 2 });
    for (let i = 0; i < 10; i += 1) expect((await service.login(attempt())).kind).toBe('success');
  });

  it('the known trade-off: failing on someone else\'s email locks THAT email out for a window', async () => {
    const { service } = setup({ LOGIN_MAX_FAILURES_PER_EMAIL: 2 });
    for (let i = 0; i < 2; i += 1) await service.login(attempt({ password: `attacker guess number ${i}`, ip: `198.51.100.${i}` }));
    expect((await service.login(attempt({ ip: '192.0.2.50' }))).kind).toBe('limited'); // the real owner, from another IP
  });
});

describe('LoginService: logging', () => {
  function captureLogs() {
    const lines: string[] = [];
    for (const method of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation((message: unknown) => void lines.push(String(message)));
    }
    return lines;
  }

  it('logs the outcome with the user id and IP: success, and each failure reason', async () => {
    const { service, users, user } = setup({ LOGIN_MAX_FAILURES_PER_EMAIL: 2 });
    users.add({ email: 'off@example.com', passwordHash: GOOD_HASH, disabled: true });
    const lines = captureLogs();

    await service.login(attempt());
    await service.login(attempt({ email: 'nobody@example.com' }));
    await service.login(attempt({ password: 'wrong password number one' }));
    await service.login(attempt({ email: 'off@example.com' }));
    await service.login(attempt({ password: 'wrong password number two' }));
    await service.login(attempt({ password: 'wrong password number three' })); // limited by email

    expect(lines).toEqual([
      `login outcome=success user=${user.id} ip=${IP}`,
      `login outcome=failure reason=unknown_email ip=${IP}`,
      `login outcome=failure reason=wrong_password user=${user.id} ip=${IP}`,
      `login outcome=failure reason=disabled user=${[...users.rows.values()].find((u) => u.email === 'off@example.com')!.id} ip=${IP}`,
      `login outcome=failure reason=wrong_password user=${user.id} ip=${IP}`,
      `login outcome=failure reason=rate_limited_email ip=${IP}`,
    ]);
  });

  it('a limited IP is logged as rate_limited_ip', async () => {
    const { service } = setup({ LOGIN_MAX_FAILURES_PER_IP: 1 });
    await service.login(attempt({ email: 'x@example.com' }));
    const lines = captureLogs();
    await service.login(attempt({ email: 'y@example.com' }));
    expect(lines).toEqual([`login outcome=failure reason=rate_limited_ip ip=${IP}`]);
  });

  it('NEVER logs the submitted email, the password, the session token or its hash, or a password hash', async () => {
    const { service, users, user } = setup();
    users.add({ email: 'off@example.com', passwordHash: GOOD_HASH, disabled: true });
    const lines = captureLogs();
    const typedAsEmail = 'my-password-typed-into-the-email-box';
    const secretPassword = 'sup3r-secret-typed-password';

    const ok = await service.login(attempt());
    await service.login(attempt({ email: typedAsEmail, password: secretPassword }));
    await service.login(attempt({ email: 'off@example.com' }));
    await service.login(attempt({ password: secretPassword }));

    const everything = lines.join('\n');
    expect(everything).not.toContain('ada@example.com');
    expect(everything.toLowerCase()).not.toContain('ada@example');
    expect(everything).not.toContain('off@example.com');
    expect(everything).not.toContain(typedAsEmail);
    expect(everything).not.toContain(secretPassword);
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toMatch(/argon2/);
    if (ok.kind === 'success') {
      expect(everything).not.toContain(ok.session.token);
      expect(everything).not.toContain(ok.session.hash);
    }
    expect(everything).not.toMatch(/cookie|token|session=/i);
    expect(everything).toContain(user.id); // ids are fine
  });
});
