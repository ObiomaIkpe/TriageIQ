import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { QueueModule } from '../queue/queue.module.js';
import { RetryPolicyModule, TRIAGE_RETRY_POLICY, type RetryPolicy } from '../queue/retry-policy.js';
import { KEEP_COMPLETED_SECONDS, KEEP_FAILED_SECONDS } from '../queue/queue.constants.js';
import { TriageClientModule } from '../triage-api/triage-client.module.js';
import { DeliveryController } from './delivery.controller.js';
import { MAILER, RECIPIENT_COUNTER, REPLY_QUEUE } from './mail.constants.js';
import { NodemailerMailer } from './mailer.js';
import { RedisRecipientCounter } from './recipient-counter.js';
import { ReplyDeliveryRepository } from './reply-delivery.repository.js';
import { ReplyDeliveryService } from './reply-delivery.service.js';
import { ReplyEmailSender } from './reply-email.sender.js';
import { ReplySweeper } from './reply-sweeper.js';

/**
 * Email delivery of approved replies: the delivery table, the "reply-email" queue, the trigger used by the review route, the
 * sender and the sweep, and the reviewer routes that show and retry a delivery. The worker part (processor, scheduler) is
 * added by WorkerModule, so a test that replaces the worker never starts it.
 */
@Module({
  imports: [
    QueueModule,
    IdempotencyModule,
    TriageClientModule,
    BullModule.registerQueueAsync({
      name: REPLY_QUEUE,
      imports: [RetryPolicyModule],
      inject: [TRIAGE_RETRY_POLICY],
      useFactory: (policy: RetryPolicy) => ({
        defaultJobOptions: {
          // The same retry policy as triage: 8 tries, 10 s doubling to 5 min (the worker's custom backoff).
          attempts: policy.attempts,
          backoff: { type: 'custom', delay: policy.backoffBaseMs },
          removeOnComplete: { age: KEEP_COMPLETED_SECONDS },
          removeOnFail: { age: KEEP_FAILED_SECONDS },
        },
      }),
    }),
  ],
  controllers: [DeliveryController],
  providers: [
    ReplyDeliveryRepository,
    ReplyDeliveryService,
    ReplyEmailSender,
    ReplySweeper,
    NodemailerMailer,
    RedisRecipientCounter,
    { provide: MAILER, useExisting: NodemailerMailer },
    { provide: RECIPIENT_COUNTER, useExisting: RedisRecipientCounter },
  ],
  exports: [ReplyDeliveryService, ReplyDeliveryRepository, ReplyEmailSender, ReplySweeper, BullModule],
})
export class MailModule {}
