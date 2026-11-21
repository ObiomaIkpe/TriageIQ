import { Inject, Injectable } from '@nestjs/common';
import { IDEMPOTENCY_REDIS, type KeyValueClient } from '../idempotency/idempotency.constants.js';
import { waitUntilReady } from '../idempotency/redis-ready.js';
import { TriageQueueService } from '../queue/triage-queue.service.js';

export const PUBLIC_IP_PREFIX = 'public:ip:';
export const PUBLIC_CAP_PREFIX = 'public:cap:';
/** The daily counter outlives its day by a margin, then vanishes on its own. */
export const CAP_TTL_SECONDS = 48 * 60 * 60;

/**
 * Counts one submission from an IP, atomically: INCR, and start the expiry only when the key is new (so a
 * refused attempt never extends the window). Returns { count, seconds left }. Attempt first, like the login limiter.
 */
export const IP_HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

/**
 * Reserves one slot of the day's cap in one atomic step: INCR, and if that went over the cap, put it back
 * and say no. Returns { 1 or 0, count after }. The key carries its UTC date and a 48 hour expiry.
 */
export const CAP_RESERVE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if count > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return { 0, count - 1 }
end
return { 1, count }
`;

/** Gives a reserved slot back (never below 0). */
export const CAP_RELEASE_SCRIPT = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count > 0 then redis.call('DECR', KEYS[1]) end
return 1
`;

/** Where the public form's counters live. Redis in production; tests use an in-memory one. */
export interface PublicStore {
  hitIp(ip: string, windowSeconds: number): Promise<{ count: number; ttlSeconds: number }>;
  reserveCap(day: string, cap: number): Promise<{ reserved: boolean; count: number }>;
  releaseCap(day: string): Promise<void>;
}

@Injectable()
export class RedisPublicStore implements PublicStore {
  constructor(
    @Inject(IDEMPOTENCY_REDIS) private readonly redis: KeyValueClient,
    @Inject(TriageQueueService) private readonly queue: TriageQueueService,
  ) {}

  private run<T>(call: () => Promise<T>): Promise<T> {
    return this.queue.guarded(async (expired) => {
      await waitUntilReady(this.redis, expired);
      if (expired()) throw new Error('deadline passed before the call was sent');
      return call();
    });
  }

  async hitIp(ip: string, windowSeconds: number) {
    const reply = (await this.run(() =>
      this.redis.eval(IP_HIT_SCRIPT, 1, PUBLIC_IP_PREFIX + ip, String(windowSeconds)),
    )) as number[];
    return { count: Number(reply[0]), ttlSeconds: Number(reply[1]) };
  }

  async reserveCap(day: string, cap: number) {
    const reply = (await this.run(() =>
      this.redis.eval(CAP_RESERVE_SCRIPT, 1, PUBLIC_CAP_PREFIX + day, String(cap), String(CAP_TTL_SECONDS)),
    )) as number[];
    return { reserved: Number(reply[0]) === 1, count: Number(reply[1]) };
  }

  async releaseCap(day: string) {
    await this.run(() => this.redis.eval(CAP_RELEASE_SCRIPT, 1, PUBLIC_CAP_PREFIX + day));
  }
}
