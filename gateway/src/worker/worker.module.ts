import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { FETCH } from '../health/health.constants.js';
import { MailModule } from '../mail/mail.module.js';
import { ReplyEmailProcessor } from '../mail/reply-email.processor.js';
import { ReplySweepScheduler } from '../mail/reply-sweep.scheduler.js';
import { QueueModule } from '../queue/queue.module.js';
import { ShutdownSafeWorker } from './shutdown-safe-worker.js';
import { TriageProcessor } from './triage.processor.js';

// Makes @nestjs/bullmq build its workers from ShutdownSafeWorker (a documented extension point).
BullModule.workerClass = ShutdownSafeWorker;

@Module({
  imports: [QueueModule, MailModule],
  providers: [
    TriageProcessor,
    ReplyEmailProcessor,
    ReplySweepScheduler,
    // The built-in fetch, through DI so tests can swap in a fake.
    { provide: FETCH, useValue: globalThis.fetch.bind(globalThis) },
  ],
})
export class WorkerModule {}
