import { FakeClock, MemoryCounterStore } from '../../test/memory-stores.js';
import { LOGIN_FAIL_EMAIL_PREFIX, LOGIN_FAIL_IP_PREFIX, LoginLimiter } from './login-limiter.js';

const EMAIL = 'e'.repeat(64);
const OTHER_EMAIL = 'f'.repeat(64);

function setup(values: Record<string, number> = {}) {
  const clock = new FakeClock();
  const store = new MemoryCounterStore(clock);
  const config = {
    get: (name: string) => ({ LOGIN_MAX_FAILURES_PER_IP: 20, LOGIN_MAX_FAILURES_PER_EMAIL: 5, LOGIN_WINDOW_MINUTES: 15, ...values })[name],
  } as never;
  return { clock, store, limiter: new LoginLimiter(store, config) };
}

describe('LoginLimiter: the attempt is counted FIRST, and the count decides', () => {
  it('uses the documented defaults: 20 per IP, 5 per email, a 15-minute window', () => {
    const { limiter } = setup();
    expect([limiter.maxPerIp, limiter.maxPerEmail, limiter.windowSeconds]).toEqual([20, 5, 900]);
  });

  it('per email: attempts 1 to 5 go on, attempt 6 is refused', async () => {
    const { limiter } = setup();
    for (let i = 1; i <= 5; i += 1) expect((await limiter.attempt('1.2.3.4', EMAIL)).limited).toBe(false);
    expect(await limiter.attempt('1.2.3.4', EMAIL)).toMatchObject({ limited: true, reason: 'rate_limited_email' });
  });

  it('per IP: twenty attempts across different emails, then the next is refused', async () => {
    const { limiter } = setup({ LOGIN_MAX_FAILURES_PER_EMAIL: 1000 });
    for (let i = 0; i < 20; i += 1) expect((await limiter.attempt('1.2.3.4', `${i}`.padStart(64, '0'))).limited).toBe(false);
    expect(await limiter.attempt('1.2.3.4', OTHER_EMAIL)).toMatchObject({ limited: true, reason: 'rate_limited_ip' });
    expect((await limiter.attempt('9.9.9.9', OTHER_EMAIL)).limited).toBe(false); // another address is fine
  });

  it('every call counts: there is no separate check that could be raced', async () => {
    const { limiter, store } = setup();
    for (let i = 1; i <= 3; i += 1) {
      await limiter.attempt('1.2.3.4', EMAIL);
      expect(store.count(LOGIN_FAIL_EMAIL_PREFIX + EMAIL)).toBe(i);
      expect(store.count(LOGIN_FAIL_IP_PREFIX + '1.2.3.4')).toBe(i);
    }
  });

  it('BOTH keys are counted in the same call (one atomic step)', async () => {
    const { limiter, store } = setup();
    await limiter.attempt('1.2.3.4', EMAIL);
    expect([store.count('login_fail:ip:1.2.3.4'), store.count(`login_fail:email:${EMAIL}`)]).toEqual([1, 1]);
  });

  it('50 attempts at once with a maximum of 5: exactly 5 go on, 45 are refused (no overshoot)', async () => {
    const { limiter } = setup();
    const decisions = await Promise.all(Array.from({ length: 50 }, () => limiter.attempt('1.2.3.4', EMAIL)));
    expect(decisions.filter((d) => !d.limited)).toHaveLength(5);
    expect(decisions.filter((d) => d.limited)).toHaveLength(45);
  });

  it('50 at once from different IPs against one email: still exactly 5 (the email limit follows the email)', async () => {
    const { limiter } = setup();
    const decisions = await Promise.all(Array.from({ length: 50 }, (_, i) => limiter.attempt(`10.0.0.${i}`, EMAIL)));
    expect(decisions.filter((d) => !d.limited)).toHaveLength(5);
  });

  it('one email being limited does not limit another email from the same address', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 6; i += 1) await limiter.attempt('1.2.3.4', EMAIL);
    expect((await limiter.attempt('1.2.3.4', EMAIL)).limited).toBe(true);
    expect((await limiter.attempt('1.2.3.4', OTHER_EMAIL)).limited).toBe(false);
  });

  it('Retry-After is the seconds left in the window, and the longer of the two when both limits apply', async () => {
    const { limiter, clock } = setup({ LOGIN_MAX_FAILURES_PER_IP: 1, LOGIN_MAX_FAILURES_PER_EMAIL: 1 });
    await limiter.attempt('1.2.3.4', EMAIL); // both windows start now
    clock.advanceSeconds(300);
    expect(await limiter.attempt('1.2.3.4', EMAIL)).toMatchObject({ limited: true, retryAfterSeconds: 600 });
  });

  it('refused attempts do NOT extend the window (a flood cannot prolong its own lockout)', async () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < 6; i += 1) await limiter.attempt('1.2.3.4', EMAIL);
    clock.advanceSeconds(600);
    for (let i = 0; i < 100; i += 1) await limiter.attempt('1.2.3.4', EMAIL);
    expect(await limiter.attempt('1.2.3.4', EMAIL)).toMatchObject({ limited: true, retryAfterSeconds: 300 }); // 900 - 600
  });

  it('the window ends: after 15 minutes the counters are gone and attempts are allowed again', async () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < 6; i += 1) await limiter.attempt('1.2.3.4', EMAIL);
    expect((await limiter.attempt('1.2.3.4', EMAIL)).limited).toBe(true);
    clock.advanceSeconds(15 * 60 + 1);
    expect((await limiter.attempt('1.2.3.4', EMAIL)).limited).toBe(false);
  });

  it('keys hold the email HASH and the IP, never an address', async () => {
    const { limiter, store } = setup();
    await limiter.attempt('1.2.3.4', EMAIL);
    expect([...store.entries.keys()].sort((a, b) => a.localeCompare(b))).toEqual([`login_fail:email:${EMAIL}`, 'login_fail:ip:1.2.3.4']);
  });

  it('custom limits and window are honoured', async () => {
    const { limiter } = setup({ LOGIN_MAX_FAILURES_PER_EMAIL: 2, LOGIN_WINDOW_MINUTES: 1 });
    await limiter.attempt('1.2.3.4', EMAIL);
    await limiter.attempt('1.2.3.4', EMAIL);
    expect(await limiter.attempt('1.2.3.4', EMAIL)).toMatchObject({ limited: true, retryAfterSeconds: 60 });
  });
});

describe('LoginLimiter.succeeded: counters at rest still mean "failures"', () => {
  it('deletes the EMAIL counter and decrements the IP counter by the successful attempt', async () => {
    const { limiter, store } = setup();
    for (let i = 0; i < 4; i += 1) await limiter.attempt('1.2.3.4', EMAIL); // four attempts that failed
    await limiter.attempt('1.2.3.4', EMAIL); // the fifth is the right password
    await limiter.succeeded('1.2.3.4', EMAIL);

    expect(store.count(`login_fail:email:${EMAIL}`)).toBe(0);
    expect(store.entries.has(`login_fail:email:${EMAIL}`)).toBe(false);
    expect(store.count('login_fail:ip:1.2.3.4')).toBe(4); // the four failures remain
  });

  it('many successful logins leave the IP counter at zero, never limiting anyone', async () => {
    const { limiter, store } = setup({ LOGIN_MAX_FAILURES_PER_IP: 2, LOGIN_MAX_FAILURES_PER_EMAIL: 2 });
    for (let i = 0; i < 50; i += 1) {
      expect((await limiter.attempt('1.2.3.4', EMAIL)).limited).toBe(false);
      await limiter.succeeded('1.2.3.4', EMAIL);
    }
    expect(store.count('login_fail:ip:1.2.3.4')).toBe(0);
  });

  it('never goes below 0, and does nothing harmful when there is nothing to decrement', async () => {
    const { limiter, store } = setup();
    await limiter.succeeded('1.2.3.4', EMAIL);
    await limiter.succeeded('1.2.3.4', EMAIL);
    expect(store.count('login_fail:ip:1.2.3.4')).toBe(0);
    await limiter.attempt('1.2.3.4', EMAIL);
    await limiter.succeeded('1.2.3.4', EMAIL);
    await limiter.succeeded('1.2.3.4', EMAIL); // an extra: floor at 0
    expect(store.count('login_fail:ip:1.2.3.4')).toBe(0);
  });

  it('another email\'s counter is untouched by this email succeeding', async () => {
    const { limiter, store } = setup();
    await limiter.attempt('1.2.3.4', OTHER_EMAIL);
    await limiter.attempt('1.2.3.4', EMAIL);
    await limiter.succeeded('1.2.3.4', EMAIL);
    expect(store.count(`login_fail:email:${OTHER_EMAIL}`)).toBe(1);
  });

  it('the IP counter of a DIFFERENT address is untouched', async () => {
    const { limiter, store } = setup();
    await limiter.attempt('9.9.9.9', EMAIL);
    await limiter.attempt('1.2.3.4', EMAIL);
    await limiter.succeeded('1.2.3.4', EMAIL);
    expect(store.count('login_fail:ip:9.9.9.9')).toBe(1);
  });
});
