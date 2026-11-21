import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { ReferencesModule } from './references.module.js';
import { TicketsController } from './tickets.controller.js';

@Module({
  imports: [QueueModule, IdempotencyModule, ReferencesModule],
  controllers: [TicketsController],
})
export class TicketsModule {}
