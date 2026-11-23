import { getQueueToken } from '@nestjs/bullmq';
import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/env.schema.js';
import { REPLY_QUEUE, SWEEP_EVERY_MS, SWEEP_JOB, SWEEP_SCHEDULER_ID } from './mail.constants.js';
import type { ReplyQueueLike } from './reply-delivery.service.js';

const logger = new Logger('ReplySweep');

/**
 * Registers the sweep as a BullMQ job scheduler (a repeating job). The scheduler's id is fixed, so every gateway that starts
 * just updates the same one, and each repetition is a single job that exactly one worker takes: no lock needed.
 */
@Injectable()
export class ReplySweepScheduler implements OnApplicationBootstrap {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<AppConfig, true>,
    @Inject(getQueueToken(REPLY_QUEUE)) private readonly queue: ReplyQueueLike,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get('MAIL_ENABLED', { infer: true })) return;
    try {
      await this.queue.upsertJobScheduler(
        SWEEP_SCHEDULER_ID,
        { every: SWEEP_EVERY_MS },
        { name: SWEEP_JOB, data: { ticket_id: '', reference: '' }, opts: { attempts: 1, removeOnComplete: true, removeOnFail: { age: 3600 } } },
      );
    } catch {
      // Redis was not reachable at start: the next start (or restart) registers it. Delivery itself does not depend on the sweep.
      logger.warn('Could not register the reply sweep (Redis not reachable); it will be registered at the next start');
    }
  }
}
