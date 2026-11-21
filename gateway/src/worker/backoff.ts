import type { BackoffStrategy } from 'bullmq';
import { RetryableTriageError } from './triage.errors.js';

/** Total tries per job: the first attempt plus four retries. */
export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 10_000;
export const BACKOFF_CAP_MS = 5 * 60 * 1000;

/**
 * How long to wait after attempt number `attemptsMade` failed:
 *   max(Retry-After, 10 s x 2^(attemptsMade - 1)), never more than 5 minutes.
 * So: 10 s, 20 s, 40 s, 80 s, 160 s, then 300 s (the cap).
 */
export function computeBackoffMs(attemptsMade: number, retryAfterSeconds?: number): number {
  const attempt = Number.isFinite(attemptsMade) ? Math.max(1, Math.floor(attemptsMade)) : 1;
  // 2 ** 30 is already far past the cap; the limit only avoids huge numbers.
  const exponential = BACKOFF_BASE_MS * 2 ** Math.min(attempt - 1, 30);
  const requested =
    retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : 0;
  return Math.min(Math.max(exponential, requested), BACKOFF_CAP_MS);
}

/**
 * BullMQ custom backoff (WorkerOptions.settings.backoffStrategy). The job option is
 * `backoff: { type: 'custom' }`. BullMQ passes the error the processor threw, which is
 * how a Retry-After from the Python service reaches this function.
 */
export const triageBackoffStrategy: BackoffStrategy = (attemptsMade, _type, error) =>
  computeBackoffMs(
    attemptsMade,
    error instanceof RetryableTriageError ? error.retryAfterSeconds : undefined,
  );
