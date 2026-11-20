import { vi } from 'vitest';
import {
  type TriageOutcome,
  callTriage,
  classifyError,
  classifyStatus,
} from './triage-outcome.js';

const BODY_TEXT = 'SECRET-TICKET-TEXT-123';
const INTERNAL_URL = 'http://app:8000';

/** Reasons are stored on the job and shown to clients: no URLs, bodies or ticket text. */
function expectSafe(outcome: TriageOutcome) {
  if (outcome.kind === 'success') return;
  expect(outcome.reason).not.toMatch(/https?:|:\/\/|app:8000|\bat\s.*\.(js|ts)|SECRET|\{|\}/);
  expect(outcome.reason.length).toBeLessThan(80);
}

describe('classifyStatus', () => {
  it.each([
    [503, 'triage service unavailable (503)'],
    [429, 'triage service rate limited (429)'],
  ])('%i -> retry, and Retry-After is read', (status, reason) => {
    expect(classifyStatus(status, '30')).toEqual({ kind: 'retry', reason, retryAfterSeconds: 30 });
    expect(classifyStatus(status, null)).toEqual({ kind: 'retry', reason, retryAfterSeconds: undefined });
    expect(classifyStatus(status, 'nonsense')).toEqual({ kind: 'retry', reason, retryAfterSeconds: undefined });
  });

  it('503 reads a Retry-After that is an HTTP date', () => {
    const now = Date.parse('2026-11-20T10:00:00Z');
    expect(classifyStatus(503, 'Fri, 20 Nov 2026 10:01:00 GMT', now)).toMatchObject({
      kind: 'retry',
      retryAfterSeconds: 60,
    });
  });

  it.each([502, 504])('%i -> retry, with no Retry-After even if the header is there', (status) => {
    expect(classifyStatus(status, '30')).toEqual({
      kind: 'retry',
      reason: `triage service unavailable (${status})`,
    });
  });

  it.each([400, 401, 403, 404, 405, 409, 410, 413, 418, 422, 451])(
    '%i (4xx) -> fail at once',
    (status) => {
      expect(classifyStatus(status, '30')).toEqual({
        kind: 'fail',
        reason: `rejected by triage service (${status})`,
      });
    },
  );

  it.each([500, 501, 505, 507, 599])('%i (other 5xx) -> fail at once, never retried', (status) => {
    expect(classifyStatus(status, '30')).toEqual({
      kind: 'fail',
      reason: `triage service error (${status})`,
    });
  });

  it.each([100, 301, 304])('%i (not a final answer) -> fail', (status) => {
    expect(classifyStatus(status, null)).toMatchObject({ kind: 'fail' });
  });

  it('every reason is safe to store', () => {
    for (const status of [429, 500, 501, 502, 503, 504, 400, 404, 409, 422, 418, 301]) {
      expectSafe(classifyStatus(status, '30'));
    }
  });
});

describe('classifyError', () => {
  const withCause = (code: string) =>
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(`connect ${code} 10.0.0.5:8000`), { code }),
    });

  it('timeout (TimeoutError from AbortSignal.timeout) -> retry', () => {
    const error = Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
    expect(classifyError(error)).toEqual({ kind: 'retry', reason: 'timeout' });
  });

  it('AbortError -> retry as a timeout', () => {
    const error = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(classifyError(error)).toEqual({ kind: 'retry', reason: 'timeout' });
  });

  it('connection refused -> retry', () => {
    expect(classifyError(withCause('ECONNREFUSED'))).toEqual({
      kind: 'retry',
      reason: 'triage service unreachable (connection refused)',
    });
  });

  it.each(['ENOTFOUND', 'EAI_AGAIN'])('DNS failure %s -> retry', (code) => {
    expect(classifyError(withCause(code))).toEqual({
      kind: 'retry',
      reason: 'triage service unreachable (host not found)',
    });
  });

  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE'])('connection reset %s -> retry', (code) => {
    expect(classifyError(withCause(code))).toEqual({
      kind: 'retry',
      reason: 'triage service unreachable (connection reset)',
    });
  });

  it.each(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'])(
    'network timeout %s -> retry as timeout',
    (code) => {
      expect(classifyError(withCause(code))).toEqual({ kind: 'retry', reason: 'timeout' });
    },
  );

  it('finds the code inside an AggregateError (several addresses tried)', () => {
    const aggregate = Object.assign(new AggregateError([withCause('ECONNREFUSED')]), {});
    const error = Object.assign(new TypeError('fetch failed'), { cause: aggregate });
    expect(classifyError(error)).toMatchObject({ kind: 'retry' });
  });

  it('an error it does not recognise -> fail (more likely our bug than something a retry fixes)', () => {
    expect(classifyError(new TypeError('Invalid URL'))).toEqual({
      kind: 'fail',
      reason: 'unexpected error contacting triage service',
    });
    expect(classifyError('a string')).toMatchObject({ kind: 'fail' });
    expect(classifyError(null)).toMatchObject({ kind: 'fail' });
  });

  it('reasons never include addresses, URLs or messages from the error', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH']) {
      const outcome = classifyError(withCause(code));
      expectSafe(outcome);
      expect(JSON.stringify(outcome)).not.toContain('10.0.0.5');
    }
  });
});

describe('callTriage', () => {
  const payload = { subject: 'Hi', body: BODY_TEXT, customer_id: 'c1' };
  // A 204 must not carry a body, so the Response is built without one.
  const reply = (status: number, text: string, headers: Record<string, string> = {}) =>
    vi.fn(async () => new Response(status === 204 ? null : text, { status, headers })) as unknown as typeof fetch;

  it('2xx with JSON -> success carrying the parsed body', async () => {
    const result = { ticket_id: 't-1', reference: 'TIQ-ABC', category: 'billing' };
    const outcome = await callTriage(reply(200, JSON.stringify(result)), INTERNAL_URL, payload, 1000);
    expect(outcome).toEqual({ kind: 'success', result });
  });

  it('sends the ticket as JSON to {base}/triage and nothing else', async () => {
    const fetchFn = reply(200, '{}');
    await callTriage(fetchFn, 'http://app:8000///', payload, 1000);

    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://app:8000/triage');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(payload);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('leaves customer_id out when there is none', async () => {
    const fetchFn = reply(200, '{}');
    await callTriage(fetchFn, INTERNAL_URL, { subject: 'a', body: 'b' }, 1000);
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ subject: 'a', body: 'b' });
  });

  it.each([
    ['not JSON', 'Internal <html>', 200],
    ['an empty body', '', 200],
    ['a 204', '', 204],
  ])('2xx with %s -> fail (invalid response)', async (_label, text, status) => {
    const outcome = await callTriage(reply(status, text), INTERNAL_URL, payload, 1000);
    expect(outcome).toEqual({ kind: 'fail', reason: 'invalid response from triage service' });
  });

  it('a 503 with Retry-After -> retry carrying the seconds', async () => {
    const fetchFn = reply(503, '{"detail":"Triage is temporarily unavailable."}', { 'Retry-After': '30' });
    expect(await callTriage(fetchFn, INTERNAL_URL, payload, 1000)).toEqual({
      kind: 'retry',
      reason: 'triage service unavailable (503)',
      retryAfterSeconds: 30,
    });
  });

  it('a 422 -> fail, and the response body text is not in the reason', async () => {
    const fetchFn = reply(422, `{"detail":[{"input":"${BODY_TEXT}"}]}`);
    const outcome = await callTriage(fetchFn, INTERNAL_URL, payload, 1000);
    expect(outcome).toEqual({ kind: 'fail', reason: 'rejected by triage service (422)' });
    expect(JSON.stringify(outcome)).not.toContain(BODY_TEXT);
  });

  it('a 500 -> fail', async () => {
    expect(await callTriage(reply(500, 'Internal Server Error'), INTERNAL_URL, payload, 1000)).toEqual({
      kind: 'fail',
      reason: 'triage service error (500)',
    });
  });

  it('a fetch that fails to connect -> retry', async () => {
    const fetchFn = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:8000'), { code: 'ECONNREFUSED' }),
      });
    }) as unknown as typeof fetch;
    const outcome = await callTriage(fetchFn, INTERNAL_URL, payload, 1000);
    expect(outcome).toMatchObject({ kind: 'retry' });
    expectSafe(outcome);
  });

  it('a hanging server is cut off by the timeout -> retry as timeout', async () => {
    const hang = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    ) as unknown as typeof fetch;

    const started = Date.now();
    const outcome = await callTriage(hang, INTERNAL_URL, payload, 50);
    expect(outcome).toEqual({ kind: 'retry', reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('a connection that drops while the body is being read -> retry', async () => {
    const broken = vi.fn(async () => {
      const stream = new ReadableStream({
        pull() {
          throw Object.assign(new TypeError('terminated'), {
            cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }),
          });
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    expect(await callTriage(broken, INTERNAL_URL, payload, 1000)).toEqual({
      kind: 'retry',
      reason: 'triage service unreachable (connection reset)',
    });
  });

  it('never throws, whatever fetch does', async () => {
    const weird = vi.fn(async () => {
      throw 'a string';
    }) as unknown as typeof fetch;
    await expect(callTriage(weird, INTERNAL_URL, payload, 1000)).resolves.toMatchObject({ kind: 'fail' });
  });
});
