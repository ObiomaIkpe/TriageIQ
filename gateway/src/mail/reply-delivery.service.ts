import { getQueueToken } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { AppConfig } from '../config/env.schema.js';
import { TriageQueueService } from '../queue/triage-queue.service.js';
import { REPLY_QUEUE, SEND_JOB } from './mail.constants.js';
import { ReplyDeliveryRepository } from './reply-delivery.repository.js';

/** The part of an approved ticket the trigger needs. (The email address is only used to see whether there is one: it is never stored here.) */
export interface ApprovedTicket {
  ticket_id: string;
  reference: string;
  status: string;
  customer_email: string | null;
  /** True for a DEMO ticket. Such a ticket is never emailed: onApproved refuses it. */
  is_demo?: boolean;
}

export type TriggerResult = 'disabled' | 'ignored' | 'skipped_no_email' | 'queued' | 'exists';

/** What a send job carries: only ids. The address and the text are fetched from the Python service when it is sent. */
export interface SendJobData {
  ticket_id: string;
  reference: string;
}

/** The Queue methods used here, so tests can pass a fake. */
export type ReplyQueueLike = Pick<Queue<SendJobData>, 'add' | 'getJob' | 'upsertJobScheduler' | 'waitUntilReady'>;

const logger = new Logger('ReplyDelivery');
const SENDABLE = new Set(['approved', 'edited']);

/**
 * "Does this approved ticket need an email?" The one place that decides, used by the review route, the sweep and the retry.
 *
 * THE RULE: nothing is emailed without a human reviewer's approval. This only ever runs after a reviewer approved or
 * edited a ticket (status approved or edited). A rejected ticket, a pending one or a freshly received one never get here.
 */
@Injectable()
export class ReplyDeliveryService {
  private readonly enabled: boolean;

  constructor(
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
    @Inject(ReplyDeliveryRepository) private readonly deliveries: ReplyDeliveryRepository,
    @Inject(getQueueToken(REPLY_QUEUE)) private readonly queue: ReplyQueueLike,
    @Inject(TriageQueueService) private readonly guard: TriageQueueService,
  ) {
    this.enabled = config.get('MAIL_ENABLED', { infer: true });
  }

  get mailEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Records the delivery and queues the job (jobId = ticket id: one ticket, at most one job). A ticket that already has a row is
   * left alone, so a repeated review or a sweep cannot make a second job. Throws if the database or Redis fails; the review
   * route catches that and logs it (the review itself stays successful), and the sweep repairs it.
   */
  async onApproved(ticket: ApprovedTicket): Promise<TriggerResult> {
    // THE DEMO RULE, first and before everything (even before the MAIL_ENABLED check): a demo ticket gets no delivery row and no job, ever.
    if (ticket.is_demo === true) return 'ignored';
    if (!this.enabled) return 'disabled';
    if (!SENDABLE.has(ticket.status)) return 'ignored';

    if (!ticket.customer_email || ticket.customer_email.trim() === '') {
      const made = await this.deliveries.insert(ticket.ticket_id, ticket.reference, 'skipped_no_email');
      if (made) logger.log(`reply_delivery outcome=skipped_no_email reference=${ticket.reference} ticket=${ticket.ticket_id}`);
      return made ? 'skipped_no_email' : 'exists';
    }

    const made = await this.deliveries.insert(ticket.ticket_id, ticket.reference, 'queued');
    if (!made) return 'exists';
    try {
      await this.addJob(ticket.ticket_id, ticket.reference);
    } catch (error) {
      // Undo the row, so the sweep (which looks for approvals without a row) makes it again.
      await this.deliveries.deleteUntried(ticket.ticket_id).catch(() => undefined);
      throw error;
    }
    logger.log(`reply_delivery outcome=queued reference=${ticket.reference} ticket=${ticket.ticket_id}`);
    return 'queued';
  }

  /** Adds the send job. Adding a job whose id already exists is a no-op in BullMQ, which is what makes this safe to repeat. */
  async addJob(ticketId: string, reference: string): Promise<void> {
    await this.guard.guarded(async (expired) => {
      await this.queue.waitUntilReady();
      if (expired()) return;
      await this.queue.add(SEND_JOB, { ticket_id: ticketId, reference }, { jobId: ticketId });
    });
  }

  /** Failed -> queued again and a new job. Returns false if the delivery is not failed. */
  async retry(ticketId: string): Promise<boolean> {
    const row = await this.deliveries.get(ticketId);
    if (!row || row.status !== 'failed') return false;
    // The finished job still sits in Redis under this id, which would make a new add a silent no-op: remove it first.
    const old = await this.queue.getJob(ticketId);
    if (old) {
      try {
        await old.remove();
      } catch {
        return false; // still active or locked: it is not finished, so it is not a failed delivery yet
      }
    }
    if (!(await this.deliveries.resetFailed(ticketId))) return false;
    try {
      await this.addJob(ticketId, row.reference);
    } catch (error) {
      await this.deliveries.markFailedFromQueued(ticketId).catch(() => undefined);
      throw error;
    }
    logger.log(`reply_delivery outcome=retry_queued reference=${row.reference} ticket=${ticketId}`);
    return true;
  }
}
