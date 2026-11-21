import { ForbiddenException, HttpException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { vi } from 'vitest';
import { IS_PUBLIC } from './auth.decorators.js';
import { AuthGuard, INVALID_KEY } from './auth.guard.js';
import { hashKey } from './client-key.js';
import { config, context, route } from './guard-fixtures.js';
import { userPrincipal } from './principal.js';
import type { SessionAuthenticator } from '../sessions/session-authenticator.js';

const KEY_ALICE = 'tiq_alice-key';
const KEY_OPS = 'tiq_ops-key';
const REGISTRY = [
  { name: 'alice', role: 'submitter', key_sha256: hashKey(KEY_ALICE) },
  { name: 'ops', role: 'reviewer', key_sha256: hashKey(KEY_OPS) },
];
const ORIGIN = 'http://localhost:5173';
const TOKEN = 'T'.repeat(43);
const COOKIE = `tiq_session=${TOKEN}`;
const USER = { id: '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34', email: 'ada@example.com', displayName: 'Ada' };

function setup(authenticate: (token: string) => Promise<ReturnType<typeof userPrincipal> | undefined> = async () => undefined) {
  const authenticator = { authenticate: vi.fn(authenticate) } as unknown as SessionAuthenticator & { authenticate: ReturnType<typeof vi.fn> };
  const guard = new AuthGuard(new Reflector(), config({ GATEWAY_CLIENTS: REGISTRY, ALLOWED_ORIGINS: [ORIGIN] }), authenticator);
  return { guard, authenticator };
}

const goodSession = async () => userPrincipal(USER, { hash: 'h'.repeat(64), expiresAt: new Date(0) });

async function failure(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('expected a throw');
}

describe('AuthGuard: API keys (unchanged behaviour)', () => {
  it('a public route needs nothing', async () => {
    const { guard, authenticator } = setup();
    expect(await guard.canActivate(context(route({ [IS_PUBLIC]: true }), {}).ctx)).toBe(true);
    expect(authenticator.authenticate).not.toHaveBeenCalled();
  });

  it('a valid key gives a client principal', async () => {
    const { guard } = setup();
    const { ctx, request } = context(route(), { headers: { authorization: `Bearer ${KEY_ALICE}` } });
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(request.principal).toMatchObject({ kind: 'client', id: 'client:alice', ownerId: 'alice', role: 'submitter' });
  });

  it('no credentials at all -> 401 {detail}, WWW-Authenticate: Bearer', async () => {
    const { guard } = setup();
    const { ctx, headers } = context(route(), { headers: {}, path: '/tickets', method: 'GET' });
    const error = await failure(guard.canActivate(ctx));
    expect(error.getStatus()).toBe(401);
    expect(error.getResponse()).toEqual({ detail: INVALID_KEY });
    expect(headers['WWW-Authenticate']).toBe('Bearer');
  });

  it('an unknown key -> 401', async () => {
    const { guard } = setup();
    const { ctx } = context(route(), { headers: { authorization: 'Bearer tiq_unknown' }, path: '/tickets', method: 'GET' });
    expect((await failure(guard.canActivate(ctx))).getStatus()).toBe(401);
  });

  it('a key request needs NO Origin, even for a write', async () => {
    const { guard } = setup();
    const { ctx } = context(route(), { method: 'POST', path: '/tickets', headers: { authorization: `Bearer ${KEY_OPS}` } });
    expect(await guard.canActivate(ctx)).toBe(true);
  });
});

describe('AuthGuard: one guard, two kinds of caller', () => {
  it('with an Authorization header present the cookie is IGNORED: a valid key wins over a cookie', async () => {
    const { guard, authenticator } = setup(goodSession);
    const { ctx, request } = context(route(), { method: 'GET', path: '/tickets', headers: { authorization: `Bearer ${KEY_ALICE}`, cookie: COOKIE } });
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(request.principal?.kind).toBe('client');
    expect(authenticator.authenticate).not.toHaveBeenCalled();
  });

  it('an INVALID key with a VALID cookie is still 401 (no fallback to the cookie)', async () => {
    const { guard, authenticator } = setup(goodSession);
    const { ctx } = context(route(), { method: 'GET', path: '/tickets', headers: { authorization: 'Bearer tiq_wrong', cookie: COOKIE } });
    expect((await failure(guard.canActivate(ctx))).getStatus()).toBe(401);
    expect(authenticator.authenticate).not.toHaveBeenCalled();
  });

  it('a malformed Authorization header (not Bearer) with a cookie is 401 too', async () => {
    const { guard } = setup(goodSession);
    const { ctx } = context(route(), { method: 'GET', path: '/tickets', headers: { authorization: 'Basic abc', cookie: COOKIE } });
    expect((await failure(guard.canActivate(ctx))).getStatus()).toBe(401);
  });

  it('a valid cookie (no Authorization header) gives a user principal', async () => {
    const { guard, authenticator } = setup(goodSession);
    const { ctx, request } = context(route(), { method: 'GET', path: '/tickets', headers: { cookie: COOKIE } });
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(authenticator.authenticate).toHaveBeenCalledWith(TOKEN);
    expect(request.principal).toMatchObject({ kind: 'user', id: `user:${USER.id}`, role: 'reviewer' });
  });

  it('a cookie the authenticator rejects -> 401', async () => {
    const { guard } = setup(async () => undefined);
    const { ctx } = context(route(), { method: 'GET', path: '/tickets', headers: { cookie: COOKIE } });
    expect((await failure(guard.canActivate(ctx))).getStatus()).toBe(401);
  });

  it('other cookies are ignored: no tiq_session cookie means no credentials', async () => {
    const { guard, authenticator } = setup(goodSession);
    const { ctx } = context(route(), { method: 'GET', path: '/tickets', headers: { cookie: 'a=1; b=2' } });
    expect((await failure(guard.canActivate(ctx))).getStatus()).toBe(401);
    expect(authenticator.authenticate).not.toHaveBeenCalled();
  });

  it('a 401 on an /auth route says "message" (for the browser); other routes keep "detail"', async () => {
    const { guard } = setup();
    const authRoute = context(route(), { headers: {}, path: '/auth/me', method: 'GET' });
    expect((await failure(guard.canActivate(authRoute.ctx))).getResponse()).toEqual({ message: 'Not authenticated' });
  });
});

describe('AuthGuard: the Origin check applies to cookie-authenticated writes', () => {
  const call = async (method: string, origin: string | undefined, path = '/tickets/x/review') => {
    const { guard, authenticator } = setup(goodSession);
    const headers: Record<string, string> = { cookie: COOKIE };
    if (origin !== undefined) headers.origin = origin;
    const { ctx } = context(route(), { method, path, headers });
    return { result: await guard.canActivate(ctx).then(() => 'allowed', (e: HttpException) => e), authenticator };
  };

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s with the allowed Origin passes', async (method) => {
    expect((await call(method, ORIGIN)).result).toBe('allowed');
  });

  it.each([
    ['missing', undefined],
    ['another site', 'http://evil.example.com'],
    ['the right host on another port', 'http://localhost:5174'],
    ['null', 'null'],
  ])('a POST with an Origin that is %s -> 403, before any session lookup', async (_label, origin) => {
    const { result, authenticator } = await call('POST', origin);
    expect(result).toBeInstanceOf(ForbiddenException);
    expect((result as HttpException).getStatus()).toBe(403);
    expect(authenticator.authenticate).not.toHaveBeenCalled();
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('%s needs no Origin', async (method) => {
    expect((await call(method, undefined)).result).toBe('allowed');
  });

  it('the 403 body uses "detail" on API routes and "message" on /auth routes', async () => {
    expect(((await call('POST', undefined)).result as HttpException).getResponse()).toEqual({ detail: 'Origin not allowed' });
    expect(((await call('POST', undefined, '/auth/something')).result as HttpException).getResponse()).toEqual({ message: 'Origin not allowed' });
  });

  it('with no allowed origins configured, every cookie write is refused (fail safe)', async () => {
    const authenticator = { authenticate: vi.fn(goodSession) } as unknown as SessionAuthenticator;
    const guard = new AuthGuard(new Reflector(), config({ GATEWAY_CLIENTS: REGISTRY, ALLOWED_ORIGINS: [] }), authenticator);
    const { ctx } = context(route(), { method: 'POST', path: '/x', headers: { cookie: COOKIE, origin: ORIGIN } });
    expect((await failure(guard.canActivate(ctx))).getStatus()).toBe(403);
  });
});

describe('AuthGuard: infrastructure trouble fails closed with a 503', () => {
  afterEach(() => vi.restoreAllMocks());

  it('Redis or Postgres failing during the session check -> 503, and the cause is not echoed or logged beyond a short code', async () => {
    const warnings: string[] = [];
    vi.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => void warnings.push(String(m)));
    const { guard } = setup(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432 password=SECRET'), { code: 'ECONNREFUSED' });
    });
    const { ctx } = context(route(), { method: 'GET', path: '/tickets', headers: { cookie: COOKIE } });

    const error = await failure(guard.canActivate(ctx));

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify(error.getResponse())).not.toMatch(/SECRET|10\.1\.2\.3/);
    expect(warnings).toEqual(['Session check failed (ECONNREFUSED)']);
    expect(warnings.join('')).not.toContain(TOKEN);
  });
});
