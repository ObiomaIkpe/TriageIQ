import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/env.schema.js';
import {
  DEFAULT_QUEUE_TIMEOUT_MS,
  KEEP_COMPLETED_SECONDS,
  KEEP_FAILED_SECONDS,
  QUEUE_TIMEOUT_MS,
  TRIAGE_QUEUE,
} from './queue.constants.js';
import { TriageQueueService } from './triage-queue.service.js';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => ({
        connection: {
          url: config.get('REDIS_URL', { infer: true }),
          // Fail at once when Redis is down instead of queueing commands until it is back.
          enableOfflineQueue: false,
        },
      }),
    }),
    BullModule.registerQueue({
      name: TRIAGE_QUEUE,
      defaultJobOptions: {
        removeOnComplete: { age: KEEP_COMPLETED_SECONDS },
        removeOnFail: { age: KEEP_FAILED_SECONDS },
      },
    }),
  ],
  providers: [
    TriageQueueService,
    { provide: QUEUE_TIMEOUT_MS, useValue: DEFAULT_QUEUE_TIMEOUT_MS },
  ],
  exports: [TriageQueueService],
})
export class QueueModule {}
