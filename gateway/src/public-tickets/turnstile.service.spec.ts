import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { TurnstileService } from './turnstile.service.js';

const SECRET = 'SECRET-SHOULD-NEVER-LOG';
const TOKEN = 'TOKEN-SHOULD-NEVER-LOG';

function make(settings: Record<string, unknown>, answer: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    // Like real fetch: an aborted signal (the timeout) rejects, however long the answer takes.
    const aborted = new Promise<never>((_, reject) =>
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))),
    );
    return Promise.race([Promise.resolve().then(answer), aborted]);
  }) as unknown as typeof fetch;
  const config = new ConfigService({
    TURNSTILE_SECRET_KEY: SECRET,
    TURNSTILE_VERIFY_URL: 'https://verify.test/siteverify',
    TURNSTILE_EXPECTED_HOSTNAMES: [],
    TURNSTILE_EXPECTED_ACTION: '',
    ...settings,
  });
  return { service: new TurnstileService(config as never, fetchFn, 200), calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('TurnstileService.verify', () => {
  it('sends the secret, the token, the IP and an idempotency key as a form to the configured URL', async () => {
    const { service, calls } = make({}, () => json({ success: true, hostname: 'example.com', 'error-codes': [] }));
    expect(await service.verify(TOKEN, '203.0.113.9')).toEqual({ kind: 'ok' });
    const form = new URLSearchParams(calls[0].init.body as URLSearchParams);
    expect(calls[0].url).toBe('https://verify.test/siteverify');
    expect(form.get('secret')).toBe(SECRET);
    expect(form.get('response')).toBe(TOKEN);
    expect(form.get('remoteip')).toBe('203.0.113.9');
    expect(form.get('idempotency_key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0].init.method).toBe('POST');
  });

  it('leaves remoteip out when the IP is unknown', async () => {
    const { service, calls } = make({}, () => json({ success: true }));
    await service.verify(TOKEN, 'unknown');
    expect(new URLSearchParams(calls[0].init.body as URLSearchParams).has('remoteip')).toBe(false);
  });

  it('success false is a failure, with Cloudflare codes (the already-spent code too)', async () => {
    const { service } = make({}, () => json({ success: false, 'error-codes': ['timeout-or-duplicate'] }));
    expect(await service.verify(TOKEN, '1.1.1.1')).toEqual({ kind: 'failed', codes: ['timeout-or-duplicate'] });
  });

  it('success false with no codes is still a failure', async () => {
    const { service } = make({}, () => json({ success: false }));
    expect(await service.verify(TOKEN, '1.1.1.1')).toEqual({ kind: 'failed', codes: ['unsuccessful'] });
  });

  it.each(['invalid-input-secret', 'missing-input-secret', 'internal-error', 'bad-request'])(
    'code %s is OUR problem, so it fails closed as unavailable',
    async (code) => {
      const { service } = make({}, () => json({ success: false, 'error-codes': [code] }));
      expect((await service.verify(TOKEN, '1.1.1.1')).kind).toBe('unavailable');
    },
  );

  it('checks the hostname when set (case-insensitive) and skips it when empty', async () => {
    const answer = () => json({ success: true, hostname: 'Example.COM' });
    expect((await make({ TURNSTILE_EXPECTED_HOSTNAMES: ['example.com'] }, answer).service.verify(TOKEN, '1.1.1.1')).kind).toBe('ok');
    expect(await make({ TURNSTILE_EXPECTED_HOSTNAMES: ['other.com'] }, answer).service.verify(TOKEN, '1.1.1.1')).toEqual({
      kind: 'failed',
      codes: ['hostname-mismatch'],
    });
    expect((await make({ TURNSTILE_EXPECTED_HOSTNAMES: [] }, answer).service.verify(TOKEN, '1.1.1.1')).kind).toBe('ok');
    // a success with no hostname at all cannot satisfy a hostname check
    expect((await make({ TURNSTILE_EXPECTED_HOSTNAMES: ['example.com'] }, () => json({ success: true })).service.verify(TOKEN, '1.1.1.1')).kind).toBe('failed');
  });

  it('checks the action when set and skips it when empty', async () => {
    const pass = () => json({ success: true, action: 'public_ticket' });
    expect((await make({ TURNSTILE_EXPECTED_ACTION: 'public_ticket' }, pass).service.verify(TOKEN, '1.1.1.1')).kind).toBe('ok');
    expect(await make({ TURNSTILE_EXPECTED_ACTION: 'public_ticket' }, () => json({ success: true, action: 'login' })).service.verify(TOKEN, '1.1.1.1')).toEqual({ kind: 'failed', codes: ['action-mismatch'] });
    expect((await make({ TURNSTILE_EXPECTED_ACTION: 'public_ticket' }, () => json({ success: true })).service.verify(TOKEN, '1.1.1.1')).kind).toBe('failed');
    expect((await make({}, () => json({ success: true })).service.verify(TOKEN, '1.1.1.1')).kind).toBe('ok');
  });

  it('fails closed: 5xx, a redirect, a network error, a timeout and garbage are all unavailable', async () => {
    for (const answer of [
      () => json({}, 500), () => json({}, 503), () => new Response(null, { status: 302, headers: { location: 'http://evil' } }),
      () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
      () => new Response('<html>', { status: 200 }), () => json({ nothing: true }), () => json('text'), () => json({ success: 'true' }),
      () => new Promise<Response>(() => undefined), // never answers: the timeout (200 ms here) ends it
    ]) {
      expect((await make({}, answer).service.verify(TOKEN, '1.1.1.1')).kind).toBe('unavailable');
    }
  });

  it('never puts the token or the secret in anything it returns or logs', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const results = [
      await make({}, () => json({ success: false, 'error-codes': ['invalid-input-secret', `leak-${TOKEN}`] })).service.verify(TOKEN, '1.1.1.1'),
      await make({}, () => json({ success: false, 'error-codes': [TOKEN] })).service.verify(TOKEN, '1.1.1.1'),
    ];
    spy.mockRestore();
    expect(JSON.stringify(results)).not.toContain(TOKEN);
    expect(JSON.stringify(results)).not.toContain(SECRET);
  });
});
