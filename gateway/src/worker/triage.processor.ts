import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Job, UnrecoverableError } from 'bullmq';
import { z } from 'zod';
import type { AppConfig } from '../config/env.schema.js';
import { FETCH } from '../health/health.constants.js';
import { TRIAGE_QUEUE } from '../queue/queue.constants.js';
import { shortReason } from '../jobs/job-status.js';
import type { TicketJobData } from '../queue/triage-queue.service.js';
import { triageBackoffStrategy } from './backoff.js';
import { callTriage, REASON_REFERENCE_CONFLICT, type TriageOutcome } from './triage-outcome.js';
import { RetryableTriageError } from './triage.errors.js';

const logger = new Logger('TriageWorker');

/**
 * Takes jobs from the "triage" queue and sends each ticket to the Python service.
 *
 *  - success         -> the Python response becomes the job result (status "done")
 *  - worth retrying  -> throws RetryableTriageError; BullMQ waits (custom backoff) and retries
 *  - not worth it    -> throws UnrecoverableError; the job fails at once, no more attempts
 */
@Processor(TRIAGE_QUEUE, { settings: { backoffStrategy: triageBackoffStrategy } })
export class TriageProcessor extends WorkerHost implements OnApplicationBootstrap {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<AppConfig, true>,
    @Inject(FETCH) private readonly fetchFn: typeof fetch,
  ) {
    super();
  }

  /**
   * @nestjs/bullmq builds the worker from decorator options, which are fixed when the code
   * loads. Concurrency comes from config, so it is set on the finished worker instead.
   */
  onApplicationBootstrap(): void {
    this.worker.concurrency = this.config.get('WORKER_CONCURRENCY', { infer: true });
  }

  async process(job: Job<TicketJobData>): Promise<unknown> {
    const attempt = job.attemptsMade + 1;
    const started = Date.now();

    const { subject, body, customer_id, reference, customer_name, customer_email } = job.data;
    const outcome = await callTriage(
      this.fetchFn,
      this.config.get('TRIAGE_SERVICE_URL', { infer: true }),
      // The job id is the same on every attempt, so Python can recognise a repeat.
      // Every gateway job id is a UUID; anything else is left out rather than sent.
      {
        subject,
        body,
        customer_id,
        ...(isUuid(job.id) ? { ticket_id: job.id } : {}),
        ...(reference === undefined ? {} : { reference }),
        ...(customer_name === undefined ? {} : { customer_name }),
        ...(customer_email === undefined ? {} : { customer_email }),
      },
      this.config.get('TRIAGE_TIMEOUT_MS', { infer: true }),
    );

    this.logAttempt(job, attempt, outcome, Date.now() - started);
    if (outcome.kind === 'fail' && outcome.reason === REASON_REFERENCE_CONFLICT) {
      // Loud on purpose: the customer was already told this reference, and it belongs to another ticket.
      logger.error(`REFERENCE CONFLICT job=${job.id} reference=${reference ?? 'unknown'}: dead-lettered, needs a person`);
    }

    switch (outcome.kind) {
      case 'success':
        return outcome.result;
      case 'retry':
        throw new RetryableTriageError(outcome.reason, outcome.retryAfterSeconds);
      case 'fail':
        throw new UnrecoverableError(outcome.reason);
    }
  }

  /** One line per attempt. Only ids, counts and fixed phrases: never the ticket text. */
  private logAttempt(job: Job<TicketJobData>, attempt: number, outcome: TriageOutcome, ms: number) {
    const result =
      outcome.kind === 'success' ? 'success' : `${outcome.kind} (${outcome.reason})`;
    const line = `job=${job.id} attempt=${attempt}/${job.opts.attempts ?? 1} outcome=${result} duration_ms=${ms}`;
    if (outcome.kind === 'success') logger.log(line);
    else logger.warn(line);
  }

  /**
   * BullMQ emits 'failed' for every failed attempt, including ones it will retry. A job is only
   * in the dead-letter list when its state is really "failed", so ask for that before logging.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<TicketJobData> | undefined, error: Error): Promise<void> {
    if (!job) return;
    try {
      if ((await job.getState()) !== 'failed') return;
    } catch {
      return; // Redis trouble: the job is not confirmed final, so say nothing.
    }
    logDeadLetter(job.id, job.attemptsMade, error.message);
  }

  @OnWorkerEvent('error')
  onError(error: NodeJS.ErrnoException): void {
    // A connection problem in the worker itself (not a job failing). Log a short code only.
    logger.warn(`Worker connection problem (${error.code ?? error.name})`);
  }
}

/** One WARN line when a job lands in the dead-letter list. Never the ticket text. */
export function logDeadLetter(jobId: string | undefined, attemptsMade: number, reason: string) {
  logger.warn(`dead-letter job=${jobId} attempts_made=${attemptsMade} reason=${shortReason(reason)}`);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && z.uuid().safeParse(value).success;
}
