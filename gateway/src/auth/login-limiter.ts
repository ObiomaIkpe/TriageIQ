import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/env.schema.js';
import { IDEMPOTENCY_REDIS, type KeyValueClient } from '../idempotency/idempotency.constants.js';
import { waitUntilReady } from '../idempotency/redis-ready.js';
import { TriageQueueService } from '../queue/triage-queue.service.js';

export const COUNTER_STORE = Symbol('COUNTER_STORE');
export const LOGIN_FAIL_IP_PREFIX = 'login_fail:ip:';
export const LOGIN_FAIL_EMAIL_PREFIX = 'login_fail:email:';

/**
 * Counts one login attempt against BOTH the IP key and the email key in a single step, setting each
 * key's expiry when it is new, and returns both counts with the seconds left: { ipCount, ipTtl,
 * emailCount, emailTtl }. Counting and checking are the same atomic step, so a burst of concurrent
 * attempts cannot slip past the limit between a check and a count.
 */
export const ATTEMPT_SCRIPT = `
local function hit(key)
  local count = redis.call('INCR', key)
  local ttl = redis.call('TTL', key)
  if count == 1 or ttl < 0 then
    redis.call('EXPIRE', key, ARGV[1])
    ttl = tonumber(ARGV[1])
  end
  return { count, ttl }
end
local ip = hit(KEYS[1])
local email = hit(KEYS[2])
return { ip[1], ip[2], email[1], email[2] }
`;

/**
 * After a SUCCESSFUL login: forget the email's counter and take this attempt back off the IP counter
 * (never below 0), so that at rest the counters still mean "failures", not "attempts".
 */
export const SUCCESS_SCRIPT = `
redis.call('DEL', KEYS[2])
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count > 0 then redis.call('DECR', KEYS[1]) end
return 1
`;

export interface Hit {
  count: number;
  ttlSeconds: number;
}

/** Where the attempt counters live. Redis in production; tests use an in-memory one. */
export interface CounterStore {
  /** Counts an attempt on both keys atomically and returns the new counts. */
  attempt(ipKey: string, emailKey: string, windowSeconds: number): Promise<{ ip: Hit; email: Hit }>;
  /** A successful login: delete the email key, decrement the IP key (floor 0). */
  success(ipKey: string, emailKey: string): Promise<void>;
}

@Injectable()
export class RedisCounterStore implements CounterStore {
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

  async attempt(ipKey: string, emailKey: string, windowSeconds: number) {
    const reply = (await this.run(() =>
      this.redis.eval(ATTEMPT_SCRIPT, 2, ipKey, emailKey, String(windowSeconds)),
    )) as number[];
    return {
      ip: { count: Number(reply[0]), ttlSeconds: Number(reply[1]) },
      email: { count: Number(reply[2]), ttlSeconds: Number(reply[3]) },
    };
  }

  async success(ipKey: string, emailKey: string) {
    await this.run(() => this.redis.eval(SUCCESS_SCRIPT, 2, ipKey, emailKey));
  }
}

export type LimitDecision =
  | { limited: false }
  | { limited: true; reason: 'rate_limited_ip' | 'rate_limited_email'; retryAfterSeconds: number };

/**
 * Login attempt limits, one fixed window each: per client IP and per email (by the SHA-256 of the
 * normalized address, so Redis never holds an email).
 *
 * The attempt is COUNTED FIRST, atomically, and the answer comes from the count itself. The count
 * must not pass the maximum: with a maximum of 5, attempts 1 to 5 go on to the password check and
 * attempt 6 is refused with Retry-After, however many arrive at once. A refused attempt costs no
 * Argon2 work. A successful login deletes the email's counter and takes its own attempt off the IP
 * counter, so counters at rest mean failures. (The earlier design checked and counted in two steps
 * and a burst of concurrent attempts overshot the limit by about the concurrency.)
 */
@Injectable()
export class LoginLimiter {
  readonly maxPerIp: number;
  readonly maxPerEmail: number;
  readonly windowSeconds: number;

  constructor(
    @Inject(COUNTER_STORE) private readonly store: CounterStore,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
  ) {
    this.maxPerIp = config.get('LOGIN_MAX_FAILURES_PER_IP', { infer: true });
    this.maxPerEmail = config.get('LOGIN_MAX_FAILURES_PER_EMAIL', { infer: true });
    this.windowSeconds = config.get('LOGIN_WINDOW_MINUTES', { infer: true }) * 60;
  }

  /** Counts this attempt and says whether it may go on. */
  async attempt(ip: string, emailHash: string): Promise<LimitDecision> {
    const { ip: byIp, email: byEmail } = await this.store.attempt(
      LOGIN_FAIL_IP_PREFIX + ip,
      LOGIN_FAIL_EMAIL_PREFIX + emailHash,
      this.windowSeconds,
    );
    const blocked: { reason: 'rate_limited_ip' | 'rate_limited_email'; wait: number }[] = [];
    if (byIp.count > this.maxPerIp) blocked.push({ reason: 'rate_limited_ip', wait: byIp.ttlSeconds });
    if (byEmail.count > this.maxPerEmail) blocked.push({ reason: 'rate_limited_email', wait: byEmail.ttlSeconds });
    if (blocked.length === 0) return { limited: false };
    // Report the one that lasts longest, so a retry after Retry-After is not refused again at once.
    const worst = blocked.reduce((a, b) => (b.wait > a.wait ? b : a));
    return { limited: true, reason: worst.reason, retryAfterSeconds: Math.max(1, worst.wait) };
  }

  /** A successful login: the email starts again from zero and the IP loses this attempt. */
  async succeeded(ip: string, emailHash: string): Promise<void> {
    await this.store.success(LOGIN_FAIL_IP_PREFIX + ip, LOGIN_FAIL_EMAIL_PREFIX + emailHash);
  }
}
