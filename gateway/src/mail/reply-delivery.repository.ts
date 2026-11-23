import { Inject, Injectable } from '@nestjs/common';
import { PG_POOL, type DbPool } from '../database/database.constants.js';
import type { DeliveryStatus } from './mail.constants.js';

export interface DeliveryRow {
  ticket_id: string;
  reference: string;
  status: DeliveryStatus;
  attempts: number;
  last_error: string | null;
  queued_at: Date;
  sent_at: Date | null;
}

const COLUMNS = 'ticket_id, reference, status, attempts, last_error, queued_at, sent_at';

/**
 * The reply_deliveries table. By design it holds NO email address and NO reply text: only the ticket id, its
 * reference, and how the delivery went. Every statement states the status it expects, so two workers (or a worker and
 * a retry) cannot overwrite each other's outcome.
 */
@Injectable()
export class ReplyDeliveryRepository {
  constructor(@Inject(PG_POOL) private readonly pool: DbPool) {}

  /** Makes the row (status queued or skipped_no_email). False if the ticket already has one (nothing is changed). */
  async insert(ticketId: string, reference: string, status: 'queued' | 'skipped_no_email'): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO reply_deliveries (ticket_id, reference, status) VALUES ($1, $2, $3)
       ON CONFLICT (ticket_id) DO NOTHING RETURNING ticket_id`,
      [ticketId, reference, status],
    );
    return result.rows.length === 1;
  }

  async get(ticketId: string): Promise<DeliveryRow | undefined> {
    const result = await this.pool.query<DeliveryRow>(`SELECT ${COLUMNS} FROM reply_deliveries WHERE ticket_id = $1`, [ticketId]);
    return result.rows[0];
  }

  /** Counts a try, only while the row is queued. Returns the new count, or undefined if the row is not queued any more. */
  async startAttempt(ticketId: string): Promise<number | undefined> {
    const result = await this.pool.query<{ attempts: number }>(
      `UPDATE reply_deliveries SET attempts = attempts + 1, updated_at = now()
       WHERE ticket_id = $1 AND status = 'queued' RETURNING attempts`,
      [ticketId],
    );
    return result.rows[0]?.attempts;
  }

  async markSent(ticketId: string): Promise<void> {
    await this.pool.query(
      `UPDATE reply_deliveries SET status = 'sent', sent_at = now(), last_error = NULL, updated_at = now()
       WHERE ticket_id = $1 AND status = 'queued'`,
      [ticketId],
    );
  }

  async markFailed(ticketId: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE reply_deliveries SET status = 'failed', last_error = $2, updated_at = now() WHERE ticket_id = $1 AND status = 'queued'`,
      [ticketId, error],
    );
  }

  async markSkippedNoEmail(ticketId: string): Promise<void> {
    await this.pool.query(
      `UPDATE reply_deliveries SET status = 'skipped_no_email', last_error = NULL, updated_at = now() WHERE ticket_id = $1 AND status = 'queued'`,
      [ticketId],
    );
  }

  /** A failed try that will be retried: remember why (a fixed phrase), stay queued. */
  async noteError(ticketId: string, error: string): Promise<void> {
    await this.pool.query(`UPDATE reply_deliveries SET last_error = $2, updated_at = now() WHERE ticket_id = $1 AND status = 'queued'`, [ticketId, error]);
  }

  /** Failed -> queued again, from zero attempts. False if the row is not failed (nothing is changed). */
  async resetFailed(ticketId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE reply_deliveries SET status = 'queued', attempts = 0, last_error = NULL, sent_at = NULL, queued_at = now(), updated_at = now()
       WHERE ticket_id = $1 AND status = 'failed' RETURNING ticket_id`,
      [ticketId],
    );
    return result.rows.length === 1;
  }

  /** A retry whose job could not be queued: back to failed, so the reviewer can press Retry again. */
  async markFailedFromQueued(ticketId: string): Promise<void> {
    await this.pool.query(
      `UPDATE reply_deliveries SET status = 'failed', last_error = 'could not queue the retry', updated_at = now() WHERE ticket_id = $1 AND status = 'queued' AND attempts = 0`,
      [ticketId],
    );
  }

  /** Undoes a row whose job could not be queued, so the sweep can do it again. Only a row that was never tried. */
  async deleteUntried(ticketId: string): Promise<void> {
    await this.pool.query(`DELETE FROM reply_deliveries WHERE ticket_id = $1 AND status = 'queued' AND attempts = 0`, [ticketId]);
  }

  /** Which of these ticket ids already have a row. */
  async existing(ticketIds: string[]): Promise<Set<string>> {
    if (ticketIds.length === 0) return new Set();
    const result = await this.pool.query<{ ticket_id: string }>('SELECT ticket_id FROM reply_deliveries WHERE ticket_id = ANY($1::uuid[])', [ticketIds]);
    return new Set(result.rows.map((row) => row.ticket_id));
  }

  /** Rows still queued after `olderThanMs`: their job may have been lost. */
  async staleQueued(olderThanMs: number): Promise<{ ticket_id: string; reference: string }[]> {
    const result = await this.pool.query<{ ticket_id: string; reference: string }>(
      `SELECT ticket_id, reference FROM reply_deliveries
       WHERE status = 'queued' AND queued_at < now() - ($1::bigint * interval '1 millisecond') LIMIT 100`,
      [olderThanMs],
    );
    return result.rows;
  }
}
