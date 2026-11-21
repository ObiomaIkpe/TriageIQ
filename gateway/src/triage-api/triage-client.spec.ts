import { HttpException, Logger } from '@nestjs/common';
import { vi } from 'vitest';
import { TriageClient, type TriageCall } from './triage-client.js';

const KEY = 'review-key-SECRETKEY-123';
const TICKET_TEXT = 'SECRET-TICKET-TEXT';
const config = {
  get: (name: string) => ({ TRIAGE_SERVICE_URL: 'http://app:8000/', TRIAGE_REVIEW_API_KEY: KEY })[name],
} as never;
const TIMEOUTS = { readMs: 50, reviewMs: 120 };

const READ: TriageCall = { method: 'GET', path: '/tickets', kind: 'read', route: 'GET /tickets', client: 'ops' };
const REVIEW: TriageCall = {
  method: 'POST',
  path: '/tickets/3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34/review',
  body: { action: 'edit', edited_reply: TICKET_TEXT },
  kind: 'review',
  route: 'POST /tickets/:id/review',
  client: 'ops',
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
const make = (fetchFn: typeof fetch) => new TriageClient(config, fetchFn, TIMEOUTS);

async function failure(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected a failure');
}

const callOf = (fetchFn: typeof fetch) =>
  (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];

describe('TriageClient: the request it builds', () => {
  it('a fresh request: only accept, x-api-key and (with a body) content-type are sent', async () => {
    const fetchFn = json(200, []);
    await make(fetchFn).call(READ);
    const [url, init] = callOf(fetchFn);
    expect(url).toBe('http://app:8000/tickets');
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ accept: 'application/json', 'x-api-key': KEY });
    expect(init.body).toBeUndefined();
    expect(init.redirect).toBe('manual'); // a redirect would carry the key elsewhere
  });

  it('a review sends the JSON body and the content type', async () => {
    const fetchFn = json(200, { ok: true });
    await make(fetchFn).call(REVIEW);
    const [url, init] = callOf(fetchFn);
    expect(url).toBe('http://app:8000/tickets/3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34/review');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      accept: 'application/json',
      'x-api-key': KEY,
      'content-type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({ action: 'edit', edited_reply: TICKET_TEXT });
  });

  it('puts only the given query parameters on the URL', async () => {
    const fetchFn = json(200, []);
    await make(fetchFn).call({ ...READ, query: { status: 'triaged', limit: '5' } });
    expect(callOf(fetchFn)[0]).toBe('http://app:8000/tickets?status=triaged&limit=5');
  });

  it('has no way to copy a client header: the call carries no headers at all', () => {
    const keys: (keyof TriageCall)[] = ['method', 'path', 'query', 'body', 'kind', 'route', 'client'];
    expect(keys).not.toContain('headers');
  });
});

describe('TriageClient: what Python answers', () => {
  it.each([
    [200, [{ id: 1 }]],
    [200, { ticket_id: 'x' }],
    [400, { detail: 'bad' }],
    [404, { detail: 'Ticket not found' }],
    [409, { detail: 'Ticket is not waiting for a review' }],
    [422, { detail: [{ msg: 'x' }] }],
  ])('%i passes through with its body', async (status, body) => {
    expect(await make(json(status, body)).call(READ)).toEqual({ status, body });
  });

  it.each([401, 503])('%i from the review key check -> 502 "Triage service rejected the gateway" and a warning', async (status) => {
    const warnings: string[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => void warnings.push(String(m)));
    const detail = status === 401 ? 'Missing or invalid API key' : 'Review is disabled: REVIEW_API_KEY is not set';
    const error = await failure(make(json(status, { detail })).call(REVIEW));
    expect(error.getStatus()).toBe(502);
    expect(error.getResponse()).toEqual({ detail: 'Triage service rejected the gateway' });
    expect(warnings.some((w) => w.includes('TRIAGE_REVIEW_API_KEY'))).toBe(true);
    for (const w of warnings) expect(w).not.toContain(KEY);
    vi.restoreAllMocks();
  });

  it('any other 503 (database or Claude trouble) -> 503 "please retry", not 502', async () => {
    const error = await failure(make(json(503, { detail: 'Database temporarily unavailable. Please retry.' })).call(REVIEW));
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({ detail: 'Triage service unavailable; please retry' });
  });

  it.each([500, 501, 502, 504])('%i -> 502 "Triage service error", with nothing from Python in it', async (status) => {
    const error = await failure(make(json(status, { detail: 'Traceback at /app/x.py http://db:5432' })).call(READ));
    expect(error.getStatus()).toBe(502);
    expect(error.getResponse()).toEqual({ detail: 'Triage service error' });
  });

  it.each([301, 302, 307, 403, 405, 413, 429])('an unexpected %i -> 502, never passed on', async (status) => {
    const error = await failure(make(json(status, { detail: 'x' })).call(READ));
    expect(error.getStatus()).toBe(502);
  });

  it('a 2xx whose body is not JSON, or empty, -> 502', async () => {
    for (const text of ['<html>', '']) {
      const fetchFn = vi.fn(async () => new Response(text, { status: 200 })) as unknown as typeof fetch;
      expect((await failure(make(fetchFn).call(READ))).getStatus()).toBe(502);
    }
  });

  it('a connection that fails -> 503, with no URL or error text in the answer', async () => {
    const fetchFn = vi.fn(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect 10.0.0.5:8000' } });
    }) as unknown as typeof fetch;
    const error = await failure(make(fetchFn).call(READ));
    expect(error.getStatus()).toBe(503);
    expect(JSON.stringify(error.getResponse())).toBe('{"detail":"Triage service unavailable; please retry"}');
  });

  it('a call that takes too long is cut off -> 503 (reads after readMs, reviews after reviewMs)', async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const fetchFn = vi.fn(hang) as unknown as typeof fetch;
    const started = Date.now();
    expect((await failure(make(fetchFn).call(READ))).getStatus()).toBe(503);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    expect(Date.now() - started).toBeLessThan(110);

    const reviewStarted = Date.now();
    expect((await failure(make(fetchFn).call(REVIEW))).getStatus()).toBe(503);
    expect(Date.now() - reviewStarted).toBeGreaterThanOrEqual(110);
  });
});

describe('TriageClient: the exact log line', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fields are separated by single spaces: client=ops route="GET /tickets" python_status=200 duration_ms=7', async () => {
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void lines.push(String(m)));
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_007);
    await make(json(200, [])).call(READ);
    expect(lines).toEqual(['client=ops route="GET /tickets" python_status=200 duration_ms=7']);
    expect(lines[0]).not.toMatch(/client=\w+route=/);
  });

  it('is the same through Nest\'s real logger (what appears in the container log)', async () => {
    const written: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });
    await make(json(200, [])).call(READ);
    write.mockRestore();
    // Strip the colour codes Nest adds, then check the message part.
    const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
    const plain = written.join('').replace(ansi, '');
    expect(plain).toMatch(/\[TriagePassthrough\] client=ops route="GET \/tickets" python_status=200 duration_ms=\d+/);
    expect(plain).not.toMatch(/client=ops\S*route=/);
  });
});

describe('TriageClient: the reviewer in the log line', () => {
  afterEach(() => vi.restoreAllMocks());

  it('adds reviewer=<namespaced id> after the route, and nothing else about the reviewer', async () => {
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void lines.push(String(m)));
    vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_004);
    await make(json(200, {})).call({ ...REVIEW, reviewer: 'user:3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34' });
    expect(lines).toEqual(['client=ops route="POST /tickets/:id/review" reviewer=user:3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34 python_status=200 duration_ms=4']);
  });

  it('without a reviewer the line is exactly as before', async () => {
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void lines.push(String(m)));
    await make(json(200, [])).call(READ);
    expect(lines[0]).not.toContain('reviewer=');
  });
});

describe('TriageClient: logging', () => {
  afterEach(() => vi.restoreAllMocks());

  it('one line per call: client, route, python status, duration; never ticket text, keys or ids', async () => {
    const lines: string[] = [];
    vi.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => void lines.push(String(m)));
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => void lines.push(String(m)));

    await make(json(200, [])).call(READ);
    await make(json(409, { detail: 'x' })).call(REVIEW);
    await failure(make(json(500, {})).call(REVIEW));
    await failure(
      make(vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch).call(READ),
    );

    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^client=ops route="GET \/tickets" python_status=200 duration_ms=\d+$/);
    expect(lines[1]).toMatch(/^client=ops route="POST \/tickets\/:id\/review" python_status=409 duration_ms=\d+$/);
    expect(lines[2]).toMatch(/python_status=500/);
    expect(lines[3]).toMatch(/python_status=unreachable/);
    for (const line of lines) {
      expect(line).not.toContain(KEY);
      expect(line).not.toContain(TICKET_TEXT);
      expect(line).not.toContain('3f6b2c1e');
    }
  });
});
