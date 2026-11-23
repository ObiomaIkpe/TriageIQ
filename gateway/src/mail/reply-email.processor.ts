import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job } from 'bullmq';
import { triageBackoffStrategy } from '../worker/backoff.js';
import { REPLY_QUEUE, SEND_JOB, SWEEP_JOB } from './mail.constants.js';
import { ReplyEmailSender } from './reply-email.sender.js';
import { ReplySweeper } from './reply-sweeper.js';
import type { SendJobData } from './reply-delivery.service.js';

const logger = new Logger('ReplyEmailWorker');

/** Takes jobs from the "reply-email" queue: "send" (one approved reply) and "sweep" (the repeating repair). Same backoff as triage. */
@Processor(REPLY_QUEUE, { settings: { backoffStrategy: triageBackoffStrategy } })
export class ReplyEmailProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    @Inject(ReplyEmailSender) private readonly sender: ReplyEmailSender,
    @Inject(ReplySweeper) private readonly sweeper: ReplySweeper,
  ) {
    super();
  }

  onApplicationBootstrap(): void {
    this.worker.concurrency = 2;
  }

  async process(job: Job<SendJobData>): Promise<unknown> {
    if (job.name === SWEEP_JOB) return this.sweeper.run();
    if (job.name === SEND_JOB) {
      return this.sender.send({ ticketId: job.data.ticket_id, attemptsMade: job.attemptsMade, attemptsMax: job.opts.attempts ?? 1 });
    }
    logger.warn(`unknown job name ${job.name.slice(0, 40)}`);
    return undefined;
  }

  @OnWorkerEvent('error')
  onError(error: NodeJS.ErrnoException): void {
    logger.warn(`Worker connection problem (${error.code ?? error.name})`);
  }
}
