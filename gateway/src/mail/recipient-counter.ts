import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { IDEMPOTENCY_REDIS, type KeyValueClient } from '../idempotency/idempotency.constants.js';
import { waitUntilReady } from '../idempotency/redis-ready.js';
import { TriageQueueService } from '../queue/triage-queue.service.js';

export const RECIPIENT_KEY_PREFIX = 'mail:rcpt:';
const TTL_SECONDS = 48 * 60 * 60;

/** The Redis key for a recipient on a UTC day. It holds the SHA-256 of the lower-cased address, never the address. */
export const recipientKey = (day: string, address: string): string =>
  `${RECIPIENT_KEY_PREFIX}${day}:${createHash('sha256').update(address.trim().toLowerCase()).digest('hex')}`;

/** INCR; over the maximum -> put it back and say no. Returns 1 (reserved) or 0 (over the limit). */
export const RESERVE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
if count > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
return 1
`;
export const RELEASE_SCRIPT = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count > 0 then redis.call('DECR', KEYS[1]) end
return 1
`;

/** How many replies a recipient got today. Redis in production; tests use an in-memory one. */
export interface RecipientCounter {
  reserve(key: string, max: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

@Injectable()
export class RedisRecipientCounter implements RecipientCounter {
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

  async reserve(key: string, max: number): Promise<boolean> {
    return Number(await this.run(() => this.redis.eval(RESERVE_SCRIPT, 1, key, String(max), String(TTL_SECONDS)))) === 1;
  }

  async release(key: string): Promise<void> {
    await this.run(() => this.redis.eval(RELEASE_SCRIPT, 1, key));
  }
}
