import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { AppConfig } from '../config/env.schema.js';
import { IDEMPOTENCY_REDIS, type KeyValueClient } from '../idempotency/idempotency.constants.js';
import { waitUntilReady } from '../idempotency/redis-ready.js';
import { TriageQueueService } from '../queue/triage-queue.service.js';
import { QueueUnavailableError } from '../queue/with-timeout.js';
import { type AuthedRequest, IS_PUBLIC } from './auth.decorators.js';

/** Injection token for the window length in seconds. Only tests change it. */
export const RATE_LIMIT_WINDOW_SECONDS = Symbol('RATE_LIMIT_WINDOW_SECONDS');
export const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;
export const RATE_LIMIT_KEY_PREFIX = 'rl:';

/**
 * Counts one request in the client's current window, in one step inside Redis. The first
 * request of a window creates the counter and starts its expiry; the counter vanishes when the
 * window ends. Returns { count, seconds left }. (An existing counter with no expiry, which
 * should not happen, gets one, so a client can never be counted forever.)
 */
export const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

export const RATE_LIMIT_UNAVAILABLE = 'Rate limiting is temporarily unavailable; please retry';

/**
 * Global guard, after the auth guard (so a 401 is never counted): a fixed window per client,
 * counted in Redis. Every authenticated response carries RateLimit-Limit and
 * RateLimit-Remaining; over the limit the answer is 429 with Retry-After. Public routes are
 * not counted. If Redis cannot be reached in time the request gets a 503.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limit: number;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
    @Inject(IDEMPOTENCY_REDIS) private readonly redis: KeyValueClient,
    @Inject(TriageQueueService) private readonly queue: TriageQueueService,
    @Inject(RATE_LIMIT_WINDOW_SECONDS) private readonly windowSeconds: number,
  ) {
    this.limit = config.get('RATE_LIMIT_PER_MINUTE', { infer: true });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const http = context.switchToHttp();
    const principal = http.getRequest<AuthedRequest>().principal;
    if (!principal) return true; // the auth guard has already refused anything without a principal

    let hit: { count: number; secondsLeft: number };
    try {
      hit = await this.queue.guarded(async (expired) => {
        await waitUntilReady(this.redis, expired);
        if (expired()) throw new Error('deadline passed before the count was sent');
        const reply = (await this.redis.eval(
          RATE_LIMIT_SCRIPT,
          1,
          RATE_LIMIT_KEY_PREFIX + principal.id, // "client:<name>" or "user:<uuid>": never shared
          String(this.windowSeconds),
        )) as [number, number];
        return { count: Number(reply[0]), secondsLeft: Number(reply[1]) };
      });
    } catch (error) {
      if (error instanceof QueueUnavailableError) {
        throw new ServiceUnavailableException({ detail: RATE_LIMIT_UNAVAILABLE });
      }
      throw error;
    }

    const response = http.getResponse<Response>();
    response.setHeader('RateLimit-Limit', String(this.limit));
    response.setHeader('RateLimit-Remaining', String(Math.max(0, this.limit - hit.count)));
    if (hit.count > this.limit) {
      response.setHeader('Retry-After', String(Math.max(1, hit.secondsLeft)));
      throw new HttpException({ detail: 'Rate limit exceeded' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
