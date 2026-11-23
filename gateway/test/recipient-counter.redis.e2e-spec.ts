import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RedisRecipientCounter, recipientKey } from '../src/mail/recipient-counter.js';

/** The per-recipient daily counter against a REAL Redis (the real Lua). Skipped unless REDIS_TEST_URL is set. */
const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
const KEY = recipientKey('2099-01-01', 'test-recipient@example.com');

describe.skipIf(!REDIS_TEST_URL)('recipient counter against a real Redis', () => {
  let redis: Redis;
  let counter: RedisRecipientCounter;
  beforeAll(() => {
    redis = new Redis(REDIS_TEST_URL as string);
    counter = new RedisRecipientCounter(redis as never, { guarded: (fn: (expired: () => boolean) => Promise<unknown>) => fn(() => false) } as never);
  });
  beforeEach(() => redis.del(KEY));
  afterAll(async () => {
    await redis.del(KEY);
    redis.disconnect();
  });

  it('allows the maximum, refuses the next, and the stored key holds a hash, never the address', async () => {
    expect([await counter.reserve(KEY, 3), await counter.reserve(KEY, 3), await counter.reserve(KEY, 3), await counter.reserve(KEY, 3)]).toEqual([true, true, true, false]);
    expect(await redis.get(KEY)).toBe('3');
    expect(KEY).not.toMatch(/test-recipient|example/);
    const ttl = await redis.ttl(KEY);
    expect(ttl).toBeGreaterThan(47 * 3600);
  });

  it('50 concurrent reservations against a maximum of 3 reserve exactly 3', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => counter.reserve(KEY, 3)));
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await redis.get(KEY)).toBe('3');
  });

  it('a released slot can be used again, and release never goes below 0', async () => {
    await counter.reserve(KEY, 1);
    expect(await counter.reserve(KEY, 1)).toBe(false);
    await counter.release(KEY);
    expect(await counter.reserve(KEY, 1)).toBe(true);
    await counter.release(KEY);
    await counter.release(KEY);
    await counter.release(KEY);
    expect(await redis.get(KEY)).toBe('0');
  });
});
