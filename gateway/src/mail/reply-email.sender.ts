import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import type { AppConfig } from '../config/env.schema.js';
import { TriageClient } from '../triage-api/triage-client.js';
import { RetryableTriageError } from '../worker/triage.errors.js';
import {
  ERR_DEMO,
  ERR_LIMIT,
  ERR_NOT_APPROVED,
  ERR_RECIPIENT,
  ERR_TRIAGE_DOWN,
  MAILER,
  RECIPIENT_COUNTER,
} from './mail.constants.js';
import { MailError, type Mailer } from './mailer.js';
import { recipientKey, type RecipientCounter } from './recipient-counter.js';
import { ReplyDeliveryRepository } from './reply-delivery.repository.js';
import { isPlainAddress, messageIdFor, replyBody, replySubject } from './reply-email.js';

const logger = new Logger('ReplyEmail');

/** Which try of how many this is (from the BullMQ job). */
export interface AttemptInfo {
  ticketId: string;
  /** Tries before this one. */
  attemptsMade: number;
  /** Total tries allowed. */
  attemptsMax: number;
}

export type SendOutcome = 'sent' | 'already_sent' | 'skipped_no_row' | 'skipped_no_email' | 'stale';

interface TicketForSend {
  reference: string;
  status: string;
  subject: string;
  final_reply: string | null;
  customer_email: string | null;
  is_demo: boolean;
}

const utcDay = () => new Date().toISOString().slice(0, 10);

/**
 * Sends one approved reply. Runs inside the BullMQ job, which supplies the retries (the same backoff as triage):
 *  - connection problems and SMTP 4xx throw RetryableTriageError (retried);
 *  - SMTP 5xx and every "this will never work" case throw UnrecoverableError (the delivery is marked failed at once);
 *  - the last try's failure also marks the delivery failed.
 * Delivery is AT LEAST ONCE: if the process dies after the mail server accepted the message and before the row says
 * "sent", the retry sends it again (the Message-ID is the same, so a duplicate is recognisable).
 *
 * Logs only the reference, the ticket id, the outcome and the attempt: never the address, the subject or the text.
 */
@Injectable()
export class ReplyEmailSender {
  private readonly maxPerDay: number;

  constructor(
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
    @Inject(ReplyDeliveryRepository) private readonly deliveries: ReplyDeliveryRepository,
    @Inject(TriageClient) private readonly triage: TriageClient,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(RECIPIENT_COUNTER) private readonly counter: RecipientCounter,
  ) {
    this.maxPerDay = config.get('MAIL_MAX_PER_RECIPIENT_PER_DAY', { infer: true });
  }

  async send(info: AttemptInfo): Promise<SendOutcome> {
    const { ticketId } = info;
    const row = await this.deliveries.get(ticketId);
    if (!row) return this.log('skipped_no_row', '?', ticketId, 0, 'skipped_no_row');
    if (row.status === 'sent') return this.log('already_sent', row.reference, ticketId, row.attempts, 'already_sent');
    if (row.status !== 'queued') return this.log('stale', row.reference, ticketId, row.attempts, 'stale'); // failed or skipped: a leftover job

    const attempt = await this.deliveries.startAttempt(ticketId);
    if (attempt === undefined) return this.log('stale', row.reference, ticketId, row.attempts, 'stale');
    const last = info.attemptsMade + 1 >= info.attemptsMax;

    // 1. The ticket as it is NOW (the reviewer may have been the only one to see it, but the database is the truth).
    const ticket = await this.readTicket(ticketId);
    if (ticket === 'unreadable') return this.fail(info, row.reference, attempt, ERR_TRIAGE_DOWN, true, last);
    // SECOND GUARD of the demo rule (the first is in the trigger): this worker asks Python for the REAL side of the wall only, so a demo
    // ticket is not even found; and if one ever were handed over, it is refused here, never sent.
    if (typeof ticket !== 'string' && ticket.is_demo) return this.fail(info, row.reference, attempt, ERR_DEMO, false, last);
    if (ticket === 'missing' || !['approved', 'edited'].includes(ticket.status) || (ticket.final_reply ?? '').trim() === '') {
      return this.fail(info, row.reference, attempt, ERR_NOT_APPROVED, false, last);
    }
    const address = (ticket.customer_email ?? '').trim();
    if (address === '') {
      await this.deliveries.markSkippedNoEmail(ticketId);
      return this.log('skipped_no_email', row.reference, ticketId, attempt, 'skipped_no_email');
    }
    if (!isPlainAddress(address)) return this.fail(info, row.reference, attempt, ERR_RECIPIENT, false, last);

    // 2. At most N replies per recipient per UTC day (the counter's key is a hash of the address).
    const key = recipientKey(utcDay(), address);
    let reserved: boolean;
    try {
      reserved = await this.counter.reserve(key, this.maxPerDay);
    } catch {
      return this.fail(info, row.reference, attempt, ERR_TRIAGE_DOWN, true, last); // the counter is unreachable: try later rather than skip the limit
    }
    if (!reserved) return this.fail(info, row.reference, attempt, ERR_LIMIT, false, last);

    // 3. Send. A slot is kept only for a message the server accepted.
    try {
      await this.mailer.send({
        to: address,
        subject: replySubject(ticket.subject, ticket.reference),
        text: replyBody(ticket.final_reply as string, ticket.reference),
        messageId: messageIdFor(ticketId),
      });
    } catch (error) {
      await this.counter.release(key).catch(() => undefined);
      const failure = error instanceof MailError ? error : new MailError('mail error', true);
      return this.fail(info, row.reference, attempt, failure.reason, failure.retryable, last);
    }
    await this.deliveries.markSent(ticketId);
    return this.log('sent', ticket.reference, ticketId, attempt, 'sent');
  }

  private async readTicket(ticketId: string): Promise<TicketForSend | 'missing' | 'unreadable'> {
    try {
      const answer = await this.triage.call({ method: 'GET', path: `/tickets/${ticketId}`, kind: 'read', scope: 'real', route: 'reply-email GET /tickets/:id', client: 'reply-email' });
      if (answer.status === 404) return 'missing';
      const body = answer.body as Partial<TicketForSend> | undefined;
      if (answer.status !== 200 || !body || typeof body.status !== 'string' || typeof body.subject !== 'string' || typeof body.reference !== 'string') return 'unreadable';
      return {
        reference: body.reference,
        status: body.status,
        subject: body.subject,
        final_reply: typeof body.final_reply === 'string' ? body.final_reply : null,
        customer_email: typeof body.customer_email === 'string' ? body.customer_email : null,
        is_demo: (body as { is_demo?: unknown }).is_demo === true,
      };
    } catch {
      return 'unreadable'; // the Python service could not be reached (the client already logged it)
    }
  }

  /** A failed try. Retryable and not the last: remember the phrase and let BullMQ retry. Otherwise the delivery is failed for good. */
  private async fail(info: AttemptInfo, reference: string, attempt: number, reason: string, retryable: boolean, last: boolean): Promise<never> {
    if (retryable && !last) {
      await this.deliveries.noteError(info.ticketId, reason);
      this.log('retry', reference, info.ticketId, attempt, `retry (${reason})`);
      throw new RetryableTriageError(reason);
    }
    await this.deliveries.markFailed(info.ticketId, reason);
    this.log('failed', reference, info.ticketId, attempt, `failed (${reason})`);
    throw new UnrecoverableError(reason);
  }

  private log<T extends string>(outcome: T, reference: string, ticketId: string, attempt: number, text: string): T {
    const line = `reply_email outcome=${text} reference=${reference} ticket=${ticketId} attempt=${attempt}`;
    if (outcome === 'sent' || outcome === 'already_sent') logger.log(line);
    else logger.warn(line);
    return outcome;
  }
}
