import {
  absoluteRemainingSeconds,
  expiresAtMs,
  isPastAbsoluteLifetime,
  isSlideDue,
  sessionTtlSeconds,
} from './session-ttl.js';

const LIFE = { idleSeconds: 60 * 60, absoluteSeconds: 8 * 3600 }; // 60 minutes idle, 8 hours absolute
const T0 = 1_000_000_000_000;
const sec = (n: number) => n * 1000;

describe('sessionTtlSeconds: the Redis TTL is the idle timeout, capped by what is left of the absolute lifetime', () => {
  it('right after login it is the idle timeout', () => {
    expect(sessionTtlSeconds(T0, T0, LIFE)).toBe(3600);
  });

  it('while far from the absolute limit it stays the idle timeout', () => {
    expect(sessionTtlSeconds(T0, T0 + sec(3 * 3600), LIFE)).toBe(3600);
  });

  it('near the absolute limit the idle timeout is cut to what remains', () => {
    // 7h30m in: 30 minutes of absolute life left, less than the 60 idle minutes
    expect(sessionTtlSeconds(T0, T0 + sec(7.5 * 3600), LIFE)).toBe(1800);
    expect(sessionTtlSeconds(T0, T0 + sec(8 * 3600 - 10), LIFE)).toBe(10);
  });

  it('exactly at, or past, the absolute limit it is 0 (the session is over)', () => {
    expect(sessionTtlSeconds(T0, T0 + sec(8 * 3600), LIFE)).toBe(0);
    expect(sessionTtlSeconds(T0, T0 + sec(9 * 3600), LIFE)).toBe(0);
  });

  it('rounds UP to whole seconds, so rounding never ends a session early', () => {
    expect(sessionTtlSeconds(T0, T0 + sec(8 * 3600) - 1500, LIFE)).toBe(2); // 1.5 s left -> 2
    expect(sessionTtlSeconds(T0, T0 + sec(8 * 3600) - 1, LIFE)).toBe(1); // 1 ms left -> 1
  });

  it('an idle timeout longer than the absolute lifetime is capped by it', () => {
    expect(sessionTtlSeconds(T0, T0, { idleSeconds: 99_999, absoluteSeconds: 600 })).toBe(600);
  });
});

describe('absolute lifetime', () => {
  it('absoluteRemainingSeconds counts down from the session start', () => {
    expect(absoluteRemainingSeconds(T0, T0, LIFE)).toBe(8 * 3600);
    expect(absoluteRemainingSeconds(T0, T0 + sec(3600), LIFE)).toBe(7 * 3600);
  });

  it('isPastAbsoluteLifetime is false just before, true at and after', () => {
    expect(isPastAbsoluteLifetime(T0, T0 + sec(8 * 3600) - 1, LIFE)).toBe(false);
    expect(isPastAbsoluteLifetime(T0, T0 + sec(8 * 3600), LIFE)).toBe(true);
    expect(isPastAbsoluteLifetime(T0, T0 + sec(100 * 3600), LIFE)).toBe(true);
  });
});

describe('expiresAtMs: the earlier of idle expiry and absolute expiry', () => {
  it('a fresh session expires after the idle timeout', () => {
    expect(expiresAtMs(T0, T0, LIFE)).toBe(T0 + sec(3600));
  });

  it('a session used long after login is capped at the absolute expiry', () => {
    const lastSeen = T0 + sec(7.9 * 3600);
    expect(expiresAtMs(T0, lastSeen, LIFE)).toBe(T0 + sec(8 * 3600));
  });
});

describe('isSlideDue: the idle timeout is written back at most once a minute', () => {
  it('not within a minute of the last write', () => {
    expect(isSlideDue(T0, T0)).toBe(false);
    expect(isSlideDue(T0, T0 + 59_999)).toBe(false);
  });

  it('due at exactly a minute and after', () => {
    expect(isSlideDue(T0, T0 + 60_000)).toBe(true);
    expect(isSlideDue(T0, T0 + 600_000)).toBe(true);
  });
});
