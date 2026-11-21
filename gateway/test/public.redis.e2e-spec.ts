import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { PUBLIC_CAP_PREFIX, PUBLIC_IP_PREFIX, RedisPublicStore } from '../src/public-tickets/public-store.js';

/**
 * The public form's two counters against a REAL Redis (the real Lua scripts). Skipped unless REDIS_TEST_URL is set.
 * It deletes the keys it creates.
 */
const REDIS_TEST_URL = process.env.REDIS_TEST_URL;
const DAY = '2099-01-01';
const IP = 'test-ip-203.0.113.7';

describe.skipIf(!REDIS_TEST_URL)('public form counters against a real Redis', () => {
  let redis: Redis;
  let store: RedisPublicStore;
  const clean = () => redis.del(PUBLIC_CAP_PREFIX + DAY, PUBLIC_IP_PREFIX + IP);

  beforeAll(() => {
    redis = new Redis(REDIS_TEST_URL as string);
    const queue = { guarded: (fn: (expired: () => boolean) => Promise<unknown>) => fn(() => false) };
    store = new RedisPublicStore(redis as never, queue as never);
  });
  beforeEach(clean);
  afterAll(async () => {
    await clean();
    redis.disconnect();
  });

  it('counts per IP, starts the expiry once and a later hit does not move it', async () => {
    const first = await store.hitIp(IP, 3600);
    expect(first.count).toBe(1);
    expect(first.ttlSeconds).toBeGreaterThan(3590);
    await redis.expire(PUBLIC_IP_PREFIX + IP, 100);
    const second = await store.hitIp(IP, 3600);
    expect(second.count).toBe(2);
    expect(second.ttlSeconds).toBeLessThanOrEqual(100);
  });

  it('50 concurrent hits count exactly 50 (atomic)', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => store.hitIp(IP, 3600)));
    expect(new Set(results.map((r) => r.count)).size).toBe(50);
    expect(Math.max(...results.map((r) => r.count))).toBe(50);
  });

  it('50 concurrent reservations against a cap of 5 reserve exactly 5, and the counter never passes 5', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => store.reserveCap(DAY, 5)));
    expect(results.filter((r) => r.reserved)).toHaveLength(5);
    expect(await redis.get(PUBLIC_CAP_PREFIX + DAY)).toBe('5');
  });

  it('the day key expires by itself after about 48 hours', async () => {
    await store.reserveCap(DAY, 5);
    const ttl = await redis.ttl(PUBLIC_CAP_PREFIX + DAY);
    expect(ttl).toBeGreaterThan(48 * 3600 - 60);
    expect(ttl).toBeLessThanOrEqual(48 * 3600);
  });

  it('a released slot can be used again, and releasing never goes below 0', async () => {
    await store.reserveCap(DAY, 1);
    expect((await store.reserveCap(DAY, 1)).reserved).toBe(false);
    await store.releaseCap(DAY);
    expect((await store.reserveCap(DAY, 1)).reserved).toBe(true);
    await store.releaseCap(DAY);
    await store.releaseCap(DAY);
    await store.releaseCap(DAY);
    expect(await redis.get(PUBLIC_CAP_PREFIX + DAY)).toBe('0');
  });

  it('a different day has its own counter', async () => {
    await store.reserveCap(DAY, 1);
    const other = await store.reserveCap('2099-01-02', 1);
    await redis.del(PUBLIC_CAP_PREFIX + '2099-01-02');
    expect(other.reserved).toBe(true);
  });
});
