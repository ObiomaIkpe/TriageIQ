import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { ReferencesModule } from '../tickets/references.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { FETCH } from '../health/health.constants.js';
import { PublicEnabledGuard } from './public-enabled.guard.js';
import { PublicIntakeService } from './public-intake.service.js';
import { PublicTicketsController } from './public-tickets.controller.js';
import { RedisPublicStore } from './public-store.js';
import { DEFAULT_TURNSTILE_TIMEOUT_MS, PUBLIC_CLOCK, PUBLIC_STORE, TURNSTILE_TIMEOUT_MS } from './public.constants.js';
import { TurnstileService } from './turnstile.service.js';

@Module({
  imports: [QueueModule, IdempotencyModule, ReferencesModule],
  controllers: [PublicTicketsController],
  providers: [
    PublicIntakeService,
    PublicEnabledGuard,
    TurnstileService,
    RedisPublicStore,
    { provide: PUBLIC_STORE, useExisting: RedisPublicStore },
    { provide: PUBLIC_CLOCK, useValue: () => Date.now() },
    { provide: TURNSTILE_TIMEOUT_MS, useValue: DEFAULT_TURNSTILE_TIMEOUT_MS },
    { provide: FETCH, useValue: globalThis.fetch.bind(globalThis) },
  ],
})
export class PublicTicketsModule {}
