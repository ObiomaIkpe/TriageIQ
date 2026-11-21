/** Injection token for how long each kind of call to the Python service may take. */
export const TRIAGE_API_TIMEOUTS = Symbol('TRIAGE_API_TIMEOUTS');

export interface TriageApiTimeouts {
  readMs: number;
  reviewMs: number;
}

export const DEFAULT_TRIAGE_API_TIMEOUTS: TriageApiTimeouts = { readMs: 10_000, reviewMs: 30_000 };

export const MSG_REJECTED = 'Triage service rejected the gateway';
export const MSG_ERROR = 'Triage service error';
export const MSG_UNAVAILABLE = 'Triage service unavailable; please retry';
