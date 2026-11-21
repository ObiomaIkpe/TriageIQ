/** The statuses the gateway reports to clients. */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

/**
 * BullMQ state -> gateway status.
 * 'unknown' (BullMQ's answer when the job vanished) and any state BullMQ adds in
 * the future are deliberately NOT mapped: the caller decides what to do with them.
 */
const STATUS_BY_STATE: Record<string, JobStatus> = {
  waiting: 'queued',
  delayed: 'queued',
  prioritized: 'queued',
  'waiting-children': 'queued',
  active: 'running',
  completed: 'done',
  failed: 'failed',
};

export function mapJobState(state: string): JobStatus | undefined {
  return Object.hasOwn(STATUS_BY_STATE, state) ? STATUS_BY_STATE[state] : undefined;
}

const MAX_REASON_LENGTH = 200;

/** A short, one-line reason for a failed job. Never a stack trace. */
export function shortReason(failedReason: string | undefined): string {
  const firstLine = (failedReason ?? '').split('\n')[0].trim();
  if (firstLine === '') return 'Job failed';
  return firstLine.length > MAX_REASON_LENGTH
    ? `${firstLine.slice(0, MAX_REASON_LENGTH)}...`
    : firstLine;
}
