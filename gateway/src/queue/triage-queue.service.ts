import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { shortReason } from '../jobs/job-status.js';
import type { TicketInput } from '../tickets/ticket.schema.js';
import { QUEUE_TIMEOUT_MS, TRIAGE_JOB_NAME, TRIAGE_QUEUE } from './queue.constants.js';
import { QueueUnavailableError, withTimeout } from './with-timeout.js';

/** What a job carries: the ticket plus when the gateway received it. */
export interface TicketJobData {
  subject: string;
  body: string;
  customer_id?: string;
  received_at: string;
  /** The API client that submitted the ticket. Missing on jobs created before M3.5a. */
  client?: string;
  /** TKT-XXXXXX, made by the gateway at accept time. Missing on older jobs: Python then makes one. */
  reference?: string;
  /** Public form only. Kept out of every log and every model prompt. */
  customer_name?: string;
  customer_email?: string;
  /** A ticket a demo visitor submitted: Python saves it as a demo ticket (never shown to real reviewers, never emailed). */
  demo?: boolean;
}

/** What a job carries beyond the ticket itself. */
export interface JobExtras {
  reference?: string;
  customer_name?: string;
  customer_email?: string;
  demo?: boolean;
}

/** The parts of a BullMQ Job this service reads. */
export interface JobLike {
  id?: string;
  data: TicketJobData;
  attemptsMade?: number;
  finishedOn?: number;
  retry(state: 'failed', options: { resetAttemptsMade: boolean; resetAttemptsStarted: boolean }): Promise<void>;
  returnvalue?: unknown;
  failedReason?: string;
  getState(): Promise<string>;
}

/** The parts of a BullMQ Queue this service uses. Tests pass a fake. */
export interface QueueLike {
  add(name: string, data: TicketJobData, options: { jobId: string }): Promise<unknown>;
  getJob(id: string): Promise<JobLike | undefined>;
  getFailed(start: number, end: number): Promise<JobLike[]>;
  getFailedCount(): Promise<number>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  waitUntilReady(): Promise<unknown>;
}

export interface JobSnapshot {
  state: string;
  data: TicketJobData;
  returnvalue: unknown;
  failedReason: string | undefined;
}

/** One entry of the dead-letter list: a job that failed for good. */
export interface DeadLetter {
  job_id: string;
  failed_at: string | null;
  received_at: string | null;
  attempts_made: number;
  reason: string;
  subject: string;
  body: string;
  customer_id: string | null;
  /** The client that submitted it; null for jobs created before M3.5a. */
  client: string | null;
}

export type RetryResult = 'queued' | 'not-found' | 'not-failed';

const logger = new Logger('TriageQueue');

@Injectable()
export class TriageQueueService {
  constructor(
    @InjectQueue(TRIAGE_QUEUE) private readonly queue: QueueLike,
    @Inject(QUEUE_TIMEOUT_MS) private readonly timeoutMs: number,
  ) {
    // Without a listener a connection error would be an unhandled 'error' event.
    // Log only a short code, never the URL (it can hold a password).
    this.queue.on('error', (error: NodeJS.ErrnoException) => {
      logger.warn(`Queue connection problem (${error.code ?? error.name})`);
    });
  }

  /** Stores the ticket as a job. Throws QueueUnavailableError unless it was really stored. */
  async enqueue(
    ticket: TicketInput,
    client: string,
    jobId: string = randomUUID(),
    extras: JobExtras = {},
  ): Promise<{ jobId: string; receivedAt: string }> {
    const receivedAt = new Date().toISOString();
    const data: TicketJobData = {
      subject: ticket.subject,
      body: ticket.body,
      customer_id: ticket.customer_id,
      received_at: receivedAt,
      client,
      ...(extras.reference === undefined ? {} : { reference: extras.reference }),
      ...(extras.customer_name === undefined ? {} : { customer_name: extras.customer_name }),
      ...(extras.customer_email === undefined ? {} : { customer_email: extras.customer_email }),
      ...(extras.demo === true ? { demo: true } : {}),
    };
    await this.guarded(async (expired) => {
      // Wait for a live connection BEFORE sending the write. Otherwise, with Redis down, the
      // write would stay pending, the client would get a 503, and the ticket would still be
      // stored when Redis came back (a retry would then create a duplicate).
      await this.queue.waitUntilReady();
      if (expired()) return;
      await this.queue.add(TRIAGE_JOB_NAME, data, { jobId });
    });
    return { jobId, receivedAt };
  }

  /** The job's current state and data, or undefined when there is no such job. */
  async findJob(id: string): Promise<JobSnapshot | undefined> {
    return this.guarded(async () => {
      let job = await this.queue.getJob(id);
      if (!job) return undefined;
      const state = await job.getState();
      if (state === 'completed' || state === 'failed') {
        // The job above may have been read just BEFORE it finished, so its result (or failure
        // reason) could still be empty. Both states are final, so read it once more.
        job = await this.queue.getJob(id);
        if (!job) return undefined;
      }
      return {
        state,
        data: job.data,
        returnvalue: job.returnvalue,
        failedReason: job.failedReason,
      };
    });
  }

  /** Failed jobs, newest failure first, plus how many there are in all. */
  async listDeadLetters(limit: number, offset: number): Promise<{ items: DeadLetter[]; total: number }> {
    return this.guarded(async () => {
      // BullMQ keeps failed jobs in a set ordered by when they finished; getFailed() reads it
      // newest first.
      const [jobs, total] = await Promise.all([
        this.queue.getFailed(offset, offset + limit - 1),
        this.queue.getFailedCount(),
      ]);
      return { items: jobs.map(toDeadLetter), total };
    });
  }

  /**
   * Puts a failed job back on the queue under the SAME id with a full set of attempts.
   * The state check and the move happen in one Redis script inside BullMQ, so two calls at
   * once cannot both succeed: the second finds the job no longer failed.
   */
  async retryDeadLetter(id: string): Promise<RetryResult> {
    return this.guarded(async (expired) => {
      await this.queue.waitUntilReady();
      const job = await this.queue.getJob(id);
      if (!job) return 'not-found';
      const state = await job.getState();
      if (state === 'unknown') return 'not-found';
      if (state !== 'failed') return 'not-failed';
      if (expired()) throw new Error('deadline passed before the retry was sent');
      try {
        // BullMQ's retry() does NOT reset the attempt counter by default, so ask for it.
        // Without it a job that used all its attempts would fail again after one try.
        await job.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
      } catch (error) {
        // Most likely someone else retried it first. Look again before deciding.
        const again = await this.queue.getJob(id);
        if (!again) return 'not-found';
        if ((await again.getState()) !== 'failed') return 'not-failed';
        throw error;
      }
      return 'queued';
    });
  }

  /**
   * Runs a call with the queue's deadline (also used for the idempotency keys). Any failure or timeout becomes QueueUnavailableError.
   * The call receives `expired()`, true once the deadline has passed, so it can stop before
   * doing anything that cannot be undone.
   */
  async guarded<T>(call: (expired: () => boolean) => Promise<T>): Promise<T> {
    let expired = false;
    try {
      return await withTimeout(
        call(() => expired),
        this.timeoutMs,
        () => {
          expired = true;
        },
      );
    } catch (error) {
      const e = error as NodeJS.ErrnoException;
      logger.warn(`Queue call failed (${e.code ?? e.name ?? 'error'})`);
      throw new QueueUnavailableError();
    }
  }
}

function toDeadLetter(job: JobLike): DeadLetter {
  return {
    job_id: String(job.id),
    failed_at: typeof job.finishedOn === 'number' ? new Date(job.finishedOn).toISOString() : null,
    received_at: job.data?.received_at ?? null,
    attempts_made: job.attemptsMade ?? 0,
    reason: shortReason(job.failedReason),
    subject: job.data?.subject,
    body: job.data?.body,
    customer_id: job.data?.customer_id ?? null,
    client: job.data?.client ?? null,
  };
}
