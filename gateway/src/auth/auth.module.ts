import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { AuthGuard } from './auth.guard.js';
import {
  DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
  RATE_LIMIT_WINDOW_SECONDS,
  RateLimitGuard,
} from './rate-limit.guard.js';
import { RolesGuard } from './roles.guard.js';

/**
 * The three global guards. Nest runs them in this order: authenticate (401), count the request
 * against the client's rate limit (429), then check the role (403). A 403 is therefore counted
 * and carries the rate-limit headers; a 401 is neither.
 */
@Module({
  imports: [QueueModule, IdempotencyModule],
  providers: [
    { provide: RATE_LIMIT_WINDOW_SECONDS, useValue: DEFAULT_RATE_LIMIT_WINDOW_SECONDS },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AuthModule {}
