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

describe('LoginLimiter', () => {
  it('uses the documented defaults: 20 per IP, 5 per email, a 15-minute window', () => {
    const { limiter } = setup();
    expect([limiter.maxPerIp, limiter.maxPerEmail, limiter.windowSeconds]).toEqual([20, 5, 900]);
  });

  it('nothing is limited before any failure', async () => {
    expect(await setup().limiter.check('1.2.3.4', EMAIL)).toEqual({ limited: false });
  });

  it('per email: five failures are allowed, the sixth attempt is refused', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 4; i += 1) {
      await limiter.recordFailure('1.2.3.4', EMAIL);
      expect((await limiter.check('1.2.3.4', EMAIL)).limited).toBe(false);
    }
    await limiter.recordFailure('1.2.3.4', EMAIL); // the fifth failure
    expect(await limiter.check('1.2.3.4', EMAIL)).toMatchObject({ limited: true, reason: 'rate_limited_email' });
  });

  it('per IP: twenty failures from one address, across different emails, then refused', async () => {
    const { limiter } = setup({ LOGIN_MAX_FAILURES_PER_EMAIL: 1000 });
    for (let i = 0; i < 20; i += 1) await limiter.recordFailure('1.2.3.4', `${i}`.padStart(64, '0'));
    expect(await limiter.check('1.2.3.4', OTHER_EMAIL)).toMatchObject({ limited: true, reason: 'rate_limited_ip' });
    expect((await limiter.check('9.9.9.9', OTHER_EMAIL)).limited).toBe(false); // another address is fine
  });

  it('one email being limited does not limit another email from the same address', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 5; i += 1) await limiter.recordFailure('1.2.3.4', EMAIL);
    expect((await limiter.check('1.2.3.4', EMAIL)).limited).toBe(true);
    expect((await limiter.check('1.2.3.4', OTHER_EMAIL)).limited).toBe(false);
  });

  it('the limit follows the email from ANY address (an attacker cannot dodge it by switching IPs)', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 5; i += 1) await limiter.recordFailure(`10.0.0.${i}`, EMAIL);
    expect((await limiter.check('203.0.113.9', EMAIL)).limited).toBe(true);
  });

  it('Retry-After is the seconds left in the window, and the longer of the two when both limits apply', async () => {
    const { limiter, clock } = setup({ LOGIN_MAX_FAILURES_PER_IP: 5 });
    for (let i = 0; i < 5; i += 1) await limiter.recordFailure('1.2.3.4', EMAIL); // both start now
    clock.advanceSeconds(300);
    expect(await limiter.check('1.2.3.4', EMAIL)).toMatchObject({ limited: true, retryAfterSeconds: 600 });
  });

  it('the window ends: after 15 minutes the counters are gone and logins are allowed again', async () => {
    const { limiter, clock } = setup();
    for (let i = 0; i < 5; i += 1) await limiter.recordFailure('1.2.3.4', EMAIL);
    expect((await limiter.check('1.2.3.4', EMAIL)).limited).toBe(true);
    clock.advanceSeconds(15 * 60 + 1);
    expect((await limiter.check('1.2.3.4', EMAIL)).limited).toBe(false);
  });

  it('a success clears the EMAIL counter (not the IP counter)', async () => {
    const { limiter } = setup();
    for (let i = 0; i < 4; i += 1) await limiter.recordFailure('1.2.3.4', EMAIL);
    await limiter.clearEmail(EMAIL);
    await limiter.recordFailure('1.2.3.4', EMAIL);
    expect((await limiter.check('1.2.3.4', EMAIL)).limited).toBe(false); // back to 1 failure
    expect((await setup().store.read(LOGIN_FAIL_EMAIL_PREFIX + EMAIL)).count).toBe(0);
  });

  it('the IP counter survives a success (so one good login cannot reset an address\'s failures)', async () => {
    const { limiter, store } = setup();
    for (let i = 0; i < 3; i += 1) await limiter.recordFailure('1.2.3.4', EMAIL);
    await limiter.clearEmail(EMAIL);
    expect((await store.read(LOGIN_FAIL_IP_PREFIX + '1.2.3.4')).count).toBe(3);
  });

  it('keys hold the email HASH and the IP, never an address', async () => {
    const { limiter, store } = setup();
    await limiter.recordFailure('1.2.3.4', EMAIL);
    expect([...store.entries.keys()].sort((a, b) => a.localeCompare(b))).toEqual([`login_fail:email:${EMAIL}`, 'login_fail:ip:1.2.3.4']);
  });

  it('reads do not change counters (a check is not a failure)', async () => {
    const { limiter, store } = setup();
    for (let i = 0; i < 10; i += 1) await limiter.check('1.2.3.4', EMAIL);
    expect(store.entries.size).toBe(0);
  });

  it('custom limits are honoured', async () => {
    const { limiter } = setup({ LOGIN_MAX_FAILURES_PER_EMAIL: 2, LOGIN_WINDOW_MINUTES: 1 });
    await limiter.recordFailure('1.2.3.4', EMAIL);
    await limiter.recordFailure('1.2.3.4', EMAIL);
    expect(await limiter.check('1.2.3.4', EMAIL)).toMatchObject({ limited: true, retryAfterSeconds: 60 });
  });
});
