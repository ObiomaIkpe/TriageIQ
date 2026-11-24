import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { SESSION_CLOCK, SESSION_STORE } from '../sessions/session.constants.js';
import { SessionService } from '../sessions/session.service.js';
import { SessionAuthenticator } from '../sessions/session-authenticator.js';
import { RedisSessionStore } from '../sessions/session.store.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { COUNTER_STORE, LoginLimiter, RedisCounterStore } from './login-limiter.js';
import { LoginService } from './login.service.js';
import { OriginGuard } from './origin.guard.js';
import { DemoOnlyGuard } from '../demo/demo-only.js';
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
  imports: [QueueModule, IdempotencyModule, UsersModule],
  controllers: [AuthController],
  providers: [
    { provide: SESSION_CLOCK, useValue: () => Date.now() },
    { provide: SESSION_STORE, useClass: RedisSessionStore },
    { provide: COUNTER_STORE, useClass: RedisCounterStore },
    SessionService,
    SessionAuthenticator,
    LoginLimiter,
    LoginService,
    OriginGuard,
    { provide: RATE_LIMIT_WINDOW_SECONDS, useValue: DEFAULT_RATE_LIMIT_WINDOW_SECONDS },
    // First: a demo route is a 404 for everyone when DEMO_MODE is off, before anyone is asked to log in.
    { provide: APP_GUARD, useClass: DemoOnlyGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [SessionService],
})
export class AuthModule {}
