/** Name of the BullMQ queue that holds tickets waiting for the Python service. */
export const TRIAGE_QUEUE = 'triage';
/** Name given to every job on that queue. */
export const TRIAGE_JOB_NAME = 'triage';

/** Injection token for how long a queue call may take, in milliseconds. */
export const QUEUE_TIMEOUT_MS = Symbol('QUEUE_TIMEOUT_MS');
/** A queue call that takes longer than this counts as "Redis is down". */
export const DEFAULT_QUEUE_TIMEOUT_MS = 2000;

/** How long finished jobs stay in Redis, in seconds. */
export const KEEP_COMPLETED_SECONDS = 24 * 60 * 60; // 1 day
/** Failed jobs are the dead-letter list, so they are kept for a month. */
export const KEEP_FAILED_SECONDS = 30 * 24 * 60 * 60; // 30 days
