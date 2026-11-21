import { parseRetryAfter } from './retry-after.js';

/** What happened when the Python service was asked to triage one ticket. */
export type TriageOutcome =
  | { kind: 'success'; result: unknown }
  /** Trying again later may help. `retryAfterSeconds` is what the service asked for, if anything. */
  | { kind: 'retry'; reason: string; retryAfterSeconds?: number }
  /** Trying again cannot help. The job fails now. */
  | { kind: 'fail'; reason: string };

/*
 * Every reason below is a fixed phrase. None of them ever contains a URL, a stack trace,
 * the response body or any ticket text, because they are stored on the job and returned
 * by GET /jobs/:id.
 */
export const REASON_TIMEOUT = 'timeout';
export const REASON_INVALID_JSON = 'invalid response from triage service';
export const REASON_UNEXPECTED = 'unexpected error contacting triage service';

/** Classifies an HTTP response from POST /triage that was not a 2xx. */
export function classifyStatus(
  status: number,
  retryAfterHeader: string | null,
  now: number = Date.now(),
): TriageOutcome {
  if (status === 503 || status === 429) {
    // These two say "come back later", so the Retry-After header is honoured.
    const reason =
      status === 429 ? 'triage service rate limited (429)' : 'triage service unavailable (503)';
    return { kind: 'retry', reason, retryAfterSeconds: parseRetryAfter(retryAfterHeader, now) };
  }
  if (status === 502 || status === 504) {
    return { kind: 'retry', reason: `triage service unavailable (${status})` };
  }
  if (status >= 400 && status < 500) {
    // 400, 404, 409, 422 and every other 4xx: the request itself is the problem.
    return { kind: 'fail', reason: `rejected by triage service (${status})` };
  }
  if (status >= 500 && status < 600) {
    // The Python service returns 500 on purpose for problems a retry cannot fix
    // (an invalid API key, a bug). 501 and any other 5xx are treated the same way.
    return { kind: 'fail', reason: `triage service error (${status})` };
  }
  return { kind: 'fail', reason: `unexpected response from triage service (${status})` };
}

const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'UND_ERR_SOCKET']);
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN']);
const UNREACHABLE_CODES = new Set(['EHOSTUNREACH', 'ENETUNREACH']);

/** Every error code found on an error, its cause chain, and any AggregateError members. */
function collectCodes(error: unknown, found: string[] = [], depth = 0): string[] {
  if (typeof error !== 'object' || error === null || depth > 4) return found;
  const e = error as { code?: unknown; cause?: unknown; errors?: unknown; name?: unknown };
  if (typeof e.code === 'string') found.push(e.code);
  if (typeof e.name === 'string' && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
    found.push(e.name);
  }
  collectCodes(e.cause, found, depth + 1);
  if (Array.isArray(e.errors)) for (const inner of e.errors) collectCodes(inner, found, depth + 1);
  return found;
}

/** Classifies an error thrown by fetch() (or while reading the response). */
export function classifyError(error: unknown): TriageOutcome {
  const codes = collectCodes(error);
  const has = (set: Set<string>) => codes.some((code) => set.has(code));

  if (codes.includes('TimeoutError') || codes.includes('AbortError') || has(TIMEOUT_CODES)) {
    return { kind: 'retry', reason: REASON_TIMEOUT };
  }
  if (codes.includes('ECONNREFUSED')) {
    return { kind: 'retry', reason: 'triage service unreachable (connection refused)' };
  }
  if (has(DNS_CODES)) {
    return { kind: 'retry', reason: 'triage service unreachable (host not found)' };
  }
  if (has(RESET_CODES)) {
    return { kind: 'retry', reason: 'triage service unreachable (connection reset)' };
  }
  if (has(UNREACHABLE_CODES)) {
    return { kind: 'retry', reason: 'triage service unreachable (network unreachable)' };
  }
  // Anything else is more likely a bug on our side than something a retry would fix.
  return { kind: 'fail', reason: REASON_UNEXPECTED };
}

/** The ticket fields the Python TicketIn model takes. */
export interface TriagePayload {
  subject: string;
  body: string;
  customer_id?: string;
}

/**
 * Calls POST {baseUrl}/triage and turns whatever happens into a TriageOutcome.
 * Never throws. The timeout covers the whole exchange, including reading the body.
 */
export async function callTriage(
  fetchFn: typeof fetch,
  baseUrl: string,
  payload: TriagePayload,
  timeoutMs: number,
): Promise<TriageOutcome> {
  const url = `${baseUrl.replace(/\/+$/, '')}/triage`;
  try {
    const response = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (response.status >= 200 && response.status < 300) {
      const text = await response.text();
      try {
        return { kind: 'success', result: JSON.parse(text) as unknown };
      } catch {
        return { kind: 'fail', reason: REASON_INVALID_JSON };
      }
    }

    // The body of an error answer is never used. Drop it so the connection is freed.
    await response.body?.cancel().catch(() => undefined);
    return classifyStatus(response.status, response.headers.get('retry-after'));
  } catch (error) {
    return classifyError(error);
  }
}
