/**
 * A failure that is worth retrying. The message is one of the fixed reasons in
 * triage-outcome.ts and is what ends up on the job as its failure reason.
 */
export class RetryableTriageError extends Error {
  constructor(
    reason: string,
    /** Seconds the Python service asked us to wait (Retry-After), if it said. */
    readonly retryAfterSeconds?: number,
  ) {
    super(reason);
    this.name = 'RetryableTriageError';
  }
}
