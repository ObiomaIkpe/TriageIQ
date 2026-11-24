import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FETCH } from '../health/health.constants.js';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { DEFAULT_TURNSTILE_TIMEOUT_MS, PUBLIC_CLOCK, PUBLIC_STORE, TURNSTILE_TIMEOUT_MS } from '../public-tickets/public.constants.js';
import { RedisPublicStore } from '../public-tickets/public-store.js';
import { TurnstileService } from '../public-tickets/turnstile.service.js';
import { ReferencesModule } from '../tickets/references.module.js';
import { UsersModule } from '../users/users.module.js';
import { DemoController } from './demo.controller.js';
import { DemoService } from './demo.service.js';
import { DemoIntakeService } from './demo-intake.service.js';

/** The demo room. Present in every build; every route in it answers 404 unless DEMO_MODE=true. */
@Module({
  imports: [AuthModule, QueueModule, IdempotencyModule, ReferencesModule, UsersModule],
  controllers: [DemoController],
  providers: [
    DemoService,
    DemoIntakeService,
    TurnstileService,
    RedisPublicStore,
    { provide: PUBLIC_STORE, useExisting: RedisPublicStore },
    { provide: PUBLIC_CLOCK, useValue: () => Date.now() },
    { provide: TURNSTILE_TIMEOUT_MS, useValue: DEFAULT_TURNSTILE_TIMEOUT_MS },
    { provide: FETCH, useValue: globalThis.fetch.bind(globalThis) },
  ],
})
export class DemoModule {}
