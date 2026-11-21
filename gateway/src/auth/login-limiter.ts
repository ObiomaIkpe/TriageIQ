import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/env.schema.js';
import { IDEMPOTENCY_REDIS, type KeyValueClient } from '../idempotency/idempotency.constants.js';
import { waitUntilReady } from '../idempotency/redis-ready.js';
import { TriageQueueService } from '../queue/triage-queue.service.js';
import { RATE_LIMIT_SCRIPT } from './rate-limit.guard.js';

export const COUNTER_STORE = Symbol('COUNTER_STORE');
export const LOGIN_FAIL_IP_PREFIX = 'login_fail:ip:';
export const LOGIN_FAIL_EMAIL_PREFIX = 'login_fail:email:';

/** Reads a counter WITHOUT changing it: { count, seconds left }. 0 and -2 mean "no such counter". */
export const READ_COUNTER_SCRIPT = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
return { count, redis.call('TTL', KEYS[1]) }
`;

/** Where the failure counters live. Redis in production; tests use an in-memory one. */
export interface CounterStore {
  read(key: string): Promise<{ count: number; ttlSeconds: number }>;
  /** Counts one failure; the first one of a window starts the expiry. */
  increment(key: string, windowSeconds: number): Promise<void>;
  remove(key: string): Promise<void>;
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

  async read(key: string) {
    const reply = (await this.run(() => this.redis.eval(READ_COUNTER_SCRIPT, 1, key))) as [number, number];
    return { count: Number(reply[0]), ttlSeconds: Number(reply[1]) };
  }

  async increment(key: string, windowSeconds: number) {
    await this.run(() => this.redis.eval(RATE_LIMIT_SCRIPT, 1, key, String(windowSeconds)));
  }

  async remove(key: string) {
    await this.run(() => this.redis.eval("return redis.call('DEL', KEYS[1])", 1, key));
  }
}

export type LimitDecision =
  | { limited: false }
  | { limited: true; reason: 'rate_limited_ip' | 'rate_limited_email'; retryAfterSeconds: number };

/**
 * Failed-login limits, one fixed window each: per client IP and per email (by the SHA-256 of the
 * normalized address, so Redis never holds an email). Only FAILURES count; a success clears the email's
 * counter. `check` runs before any password hashing, so a limited caller costs no Argon2 work.
 * A counter at or above the maximum blocks: with a maximum of 5, five failures are allowed and the sixth
 * attempt is refused.
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

  async check(ip: string, emailHash: string): Promise<LimitDecision> {
    const [byIp, byEmail] = await Promise.all([
      this.store.read(LOGIN_FAIL_IP_PREFIX + ip),
      this.store.read(LOGIN_FAIL_EMAIL_PREFIX + emailHash),
    ]);
    const blocked: { reason: 'rate_limited_ip' | 'rate_limited_email'; wait: number }[] = [];
    if (byIp.count >= this.maxPerIp) blocked.push({ reason: 'rate_limited_ip', wait: byIp.ttlSeconds });
    if (byEmail.count >= this.maxPerEmail) blocked.push({ reason: 'rate_limited_email', wait: byEmail.ttlSeconds });
    if (blocked.length === 0) return { limited: false };
    // Report the one that lasts longest, so a retry after Retry-After is not refused again at once.
    const worst = blocked.reduce((a, b) => (b.wait > a.wait ? b : a));
    return { limited: true, reason: worst.reason, retryAfterSeconds: Math.max(1, worst.wait) };
  }

  async recordFailure(ip: string, emailHash: string): Promise<void> {
    await Promise.all([
      this.store.increment(LOGIN_FAIL_IP_PREFIX + ip, this.windowSeconds),
      this.store.increment(LOGIN_FAIL_EMAIL_PREFIX + emailHash, this.windowSeconds),
    ]);
  }

  async clearEmail(emailHash: string): Promise<void> {
    await this.store.remove(LOGIN_FAIL_EMAIL_PREFIX + emailHash);
  }
}
