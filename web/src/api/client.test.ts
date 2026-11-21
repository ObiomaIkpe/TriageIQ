import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { server } from '../test/server.js';
import { api, parseRetryAfter, setUnauthorizedHandler } from './client.js';
import { ApiError, ForbiddenError, NetworkError, RateLimitedError, ServerError, UnauthorizedError } from './errors.js';

const answer = (status: number, headers: Record<string, string> = {}) =>
  server.use(http.get('/api/thing', () => HttpResponse.json({ message: 'server text' }, { status, headers })));

describe('api client', () => {
  it('calls /api paths, same-origin, with JSON and no Authorization header', async () => {
    let seen: Request | undefined;
    server.use(
      http.post('/api/things', async ({ request }) => {
        seen = request.clone();
        return HttpResponse.json({ ok: true });
      }),
    );
    const spy = vi.spyOn(globalThis, 'fetch');

    await expect(api('/things', { method: 'POST', body: { a: 1 } })).resolves.toEqual({ ok: true });

    expect(new URL(seen!.url).pathname).toBe('/api/things');
    expect(seen!.headers.get('authorization')).toBeNull();
    expect(seen!.headers.get('content-type')).toBe('application/json');
    expect(await seen!.json()).toEqual({ a: 1 });
    expect(spy.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin' });
    expect(spy.mock.calls[0]?.[0]).toBe('/api/things');
  });

  it('keeps nothing in localStorage or sessionStorage', async () => {
    server.use(http.get('/api/thing', () => HttpResponse.json({ user: 'x' })));
    await api('/thing');
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });

  it('a 204 is undefined', async () => {
    server.use(http.post('/api/thing', () => new HttpResponse(null, { status: 204 })));
    await expect(api('/thing', { method: 'POST' })).resolves.toBeUndefined();
  });

  it.each([
    [401, UnauthorizedError],
    [403, ForbiddenError],
    [429, RateLimitedError],
    [500, ServerError],
    [503, ServerError],
    [404, ApiError],
  ])('status %i becomes a typed error that carries no server text', async (status, type) => {
    answer(status);
    const error = await api('/thing').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(type);
    expect((error as Error).message).not.toContain('server text');
  });

  it('a 429 carries Retry-After as seconds (and undefined when missing or not a number)', async () => {
    answer(429, { 'Retry-After': '90' });
    expect(((await api('/thing').catch((e: unknown) => e)) as RateLimitedError).retryAfterSeconds).toBe(90);
    answer(429);
    expect(((await api('/thing').catch((e: unknown) => e)) as RateLimitedError).retryAfterSeconds).toBeUndefined();
    answer(429, { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' });
    expect(((await api('/thing').catch((e: unknown) => e)) as RateLimitedError).retryAfterSeconds).toBeUndefined();
  });

  it('no answer at all is a NetworkError', async () => {
    server.use(http.get('/api/thing', () => HttpResponse.error()));
    await expect(api('/thing')).rejects.toBeInstanceOf(NetworkError);
  });

  it('a 401 calls the session-ended handler, unless the call says a 401 is an ordinary answer', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    answer(401);
    await api('/thing').catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
    await api('/thing', { sessionEndsOn401: false }).catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['30', 30],
    [' 7 ', 7],
    ['0', 0],
    [null, undefined],
    ['abc', undefined],
    ['-5', undefined],
    ['1.5', undefined],
  ])('parseRetryAfter(%j) = %j', (value, expected) => {
    expect(parseRetryAfter(value)).toBe(expected);
  });
});
