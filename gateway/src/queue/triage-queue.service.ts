import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { TicketInput } from '../tickets/ticket.schema.js';
import { QUEUE_TIMEOUT_MS, TRIAGE_JOB_NAME, TRIAGE_QUEUE } from './queue.constants.js';
import { QueueUnavailableError, withTimeout } from './with-timeout.js';

/** What a job carries: the ticket plus when the gateway received it. */
export interface TicketJobData {
  subject: string;
  body: string;
  customer_id?: string;
  received_at: string;
}

/** The parts of a BullMQ Job this service reads. */
export interface JobLike {
  data: TicketJobData;
  returnvalue?: unknown;
  failedReason?: string;
  getState(): Promise<string>;
}

/** The parts of a BullMQ Queue this service uses. Tests pass a fake. */
export interface QueueLike {
  add(name: string, data: TicketJobData, options: { jobId: string }): Promise<unknown>;
  getJob(id: string): Promise<JobLike | undefined>;
  on(event: 'error', listener: (error: Error) => void): unknown;
  waitUntilReady(): Promise<unknown>;
}

export interface JobSnapshot {
  state: string;
  data: TicketJobData;
  returnvalue: unknown;
  failedReason: string | undefined;
}

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
  async enqueue(ticket: TicketInput): Promise<{ jobId: string; receivedAt: string }> {
    const jobId = randomUUID();
    const receivedAt = new Date().toISOString();
    const data: TicketJobData = {
      subject: ticket.subject,
      body: ticket.body,
      customer_id: ticket.customer_id,
      received_at: receivedAt,
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

  /**
   * Runs a queue call with a deadline. Any failure or timeout becomes QueueUnavailableError.
   * The call receives `expired()`, true once the deadline has passed, so it can stop before
   * doing anything that cannot be undone.
   */
  private async guarded<T>(call: (expired: () => boolean) => Promise<T>): Promise<T> {
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
