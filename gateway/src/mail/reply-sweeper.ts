import { getQueueToken } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { TriageClient } from '../triage-api/triage-client.js';
import { REPLY_QUEUE, STALE_QUEUED_MS, SWEEP_WINDOW_DAYS } from './mail.constants.js';
import { ReplyDeliveryRepository } from './reply-delivery.repository.js';
import { ReplyDeliveryService, type ApprovedTicket, type ReplyQueueLike } from './reply-delivery.service.js';

const logger = new Logger('ReplySweep');
const PAGE = 200;
const MAX_PAGES = 10;

export interface SweepResult {
  checked: number;
  repaired: number;
  requeued: number;
}

/**
 * Repairs missed deliveries (a review whose trigger failed, a restart in the middle). Runs every 5 minutes as a BullMQ
 * repeatable job, so exactly one worker runs it at a time. It asks Python for approved and edited tickets reviewed in the
 * last 7 days and, for each one with no delivery row, does what the review route does. It also re-adds the job of a row
 * that has been "queued" for a long time (adding is idempotent: an existing job is left alone).
 */
@Injectable()
export class ReplySweeper {
  constructor(
    @Inject(TriageClient) private readonly triage: TriageClient,
    @Inject(ReplyDeliveryRepository) private readonly deliveries: ReplyDeliveryRepository,
    @Inject(ReplyDeliveryService) private readonly service: ReplyDeliveryService,
    @Inject(getQueueToken(REPLY_QUEUE)) private readonly queue: ReplyQueueLike,
  ) {}

  async run(now: Date = new Date()): Promise<SweepResult> {
    const since = new Date(now.getTime() - SWEEP_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const result: SweepResult = { checked: 0, repaired: 0, requeued: 0 };

    for (const status of ['approved', 'edited'] as const) {
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const tickets = await this.readPage(status, since, cursor);
        const ids = tickets.map((t) => t.ticket_id);
        const have = await this.deliveries.existing(ids);
        for (const ticket of tickets) {
          result.checked += 1;
          if (have.has(ticket.ticket_id)) continue;
          try {
            const outcome = await this.service.onApproved(ticket);
            if (outcome === 'queued' || outcome === 'skipped_no_email') result.repaired += 1;
          } catch {
            logger.error(`could not repair the delivery of ${ticket.reference} (ticket ${ticket.ticket_id}); the next sweep will try again`);
          }
        }
        const last = tickets[tickets.length - 1];
        if (tickets.length < PAGE || !last) break;
        cursor = `${last.created_at}|${last.ticket_id}`;
      }
    }

    for (const row of await this.deliveries.staleQueued(STALE_QUEUED_MS)) {
      if (await this.queue.getJob(row.ticket_id)) continue;
      try {
        await this.service.addJob(row.ticket_id, row.reference);
        result.requeued += 1;
      } catch {
        logger.error(`could not re-queue the delivery of ${row.reference} (ticket ${row.ticket_id})`);
      }
    }
    logger.log(`sweep checked=${result.checked} repaired=${result.repaired} requeued=${result.requeued}`);
    return result;
  }

  private async readPage(status: string, since: string, cursor?: string): Promise<(ApprovedTicket & { created_at: string })[]> {
    const query: Record<string, string> = { status, reviewed_since: since, limit: String(PAGE) };
    if (cursor) query.cursor = cursor;
    const answer = await this.triage.call({ method: 'GET', path: '/tickets', query, kind: 'read', scope: 'real', route: 'reply-sweep GET /tickets', client: 'reply-sweep' });
    if (!Array.isArray(answer.body)) throw new Error('unexpected answer');
    return answer.body.filter(
      (t): t is ApprovedTicket & { created_at: string } =>
        typeof t === 'object' && t !== null && typeof t.ticket_id === 'string' && typeof t.reference === 'string' && typeof t.status === 'string' && typeof t.created_at === 'string',
    ).map((t) => ({ ticket_id: t.ticket_id, reference: t.reference, status: t.status, customer_email: typeof t.customer_email === 'string' ? t.customer_email : null, is_demo: t.is_demo === true, created_at: t.created_at }));
  }
}
