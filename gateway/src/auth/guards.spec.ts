import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { FakeKeyValue, FakeQueue } from '../../test/fake-queue.js';
import { TriageQueueService, type QueueLike } from '../queue/triage-queue.service.js';
import { IS_PUBLIC, ROLES_KEY } from './auth.decorators.js';
import type { Role } from './auth.types.js';
import { config, context, route, thrown } from './guard-fixtures.js';
import { clientPrincipal, type ClientPrincipal } from './principal.js';
import { RATE_LIMIT_UNAVAILABLE, RateLimitGuard } from './rate-limit.guard.js';
import { RolesGuard } from './roles.guard.js';

describe('RolesGuard', () => {
  const guard = new RolesGuard(new Reflector());
  const as = (role: Role): ClientPrincipal => clientPrincipal('x', role);

  it('a route without @Roles is open to every authenticated client', () => {
    for (const role of ['submitter', 'reviewer'] as const) {
      expect(guard.canActivate(context(route(), { principal: as(role) }).ctx)).toBe(true);
    }
  });

  it('@Roles("reviewer"): a reviewer passes', () => {
    expect(guard.canActivate(context(route({ [ROLES_KEY]: ['reviewer'] }), { principal: as('reviewer') }).ctx)).toBe(true);
  });

  it('@Roles("reviewer"): a submitter gets 403 { detail: "Not allowed" }', () => {
    const error = thrown(() => guard.canActivate(context(route({ [ROLES_KEY]: ['reviewer'] }), { principal: as('submitter') }).ctx));
    expect(error.getStatus()).toBe(403);
    expect(error.getResponse()).toEqual({ detail: 'Not allowed' });
  });

  it('a role-limited route with no client at all is refused, not allowed', () => {
    expect(thrown(() => guard.canActivate(context(route({ [ROLES_KEY]: ['reviewer'] }), {}).ctx)).getStatus()).toBe(403);
  });

  it('a public route is never role-checked', () => {
    expect(guard.canActivate(context(route({ [IS_PUBLIC]: true, [ROLES_KEY]: ['reviewer'] }), {}).ctx)).toBe(true);
  });
});

describe('RateLimitGuard', () => {
  const ALICE = clientPrincipal('alice', 'submitter');
  const BOB = clientPrincipal('bob', 'submitter');

  function setup(limit = 3, window = 60) {
    const queue = new FakeQueue();
    const kv = queue.kv as FakeKeyValue;
    const service = new TriageQueueService(queue as QueueLike, 60);
    const guard = new RateLimitGuard(new Reflector(), config({ RATE_LIMIT_PER_MINUTE: limit }), kv, service, window);
    const call = async (client: ClientPrincipal | undefined, route_ = route()) => {
      const made = context(route_, client ? { principal: client } : {});
      try {
        await guard.canActivate(made.ctx);
        return { ok: true as const, headers: made.headers };
      } catch (error) {
        return { ok: false as const, error: error as HttpException, headers: made.headers };
      }
    };
    return { kv, queue, call };
  }

  it('counts per request: RateLimit-Limit and RateLimit-Remaining go 2, 1, 0', async () => {
    const { call } = setup(3);
    const seen = [];
    for (let i = 0; i < 3; i += 1) {
      const result = await call(ALICE);
      expect(result.ok).toBe(true);
      seen.push([result.headers['RateLimit-Limit'], result.headers['RateLimit-Remaining']]);
    }
    expect(seen).toEqual([['3', '2'], ['3', '1'], ['3', '0']]);
  });

  it('the request after the limit -> 429 { detail } with Retry-After, Remaining 0 and the limit header', async () => {
    const { call } = setup(2, 60);
    await call(ALICE);
    await call(ALICE);
    const over = await call(ALICE);
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.error.getStatus()).toBe(429);
    expect(over.error.getResponse()).toEqual({ detail: 'Rate limit exceeded' });
    expect(over.headers['Retry-After']).toBe('60');
    expect(over.headers['RateLimit-Limit']).toBe('2');
    expect(over.headers['RateLimit-Remaining']).toBe('0');
  });

  it('Retry-After is the seconds left in the window, rounded up, never below 1', async () => {
    const { kv, call } = setup(1, 60);
    let now = 1_000_000;
    kv.now = () => now;
    await call(ALICE);
    now += 45_500; // 14.5 s left
    const over = await call(ALICE);
    expect(over.ok === false && over.headers['Retry-After']).toBe('15');
    now += 14_400; // 0.1 s left
    const nearly = await call(ALICE);
    expect(nearly.ok === false && nearly.headers['Retry-After']).toBe('1');
  });

  it('the window resets: after it ends the count starts again at the full limit', async () => {
    const { kv, call } = setup(1, 60);
    let now = 5_000_000;
    kv.now = () => now;
    await call(ALICE);
    expect((await call(ALICE)).ok).toBe(false);
    now += 60_001;
    const again = await call(ALICE);
    expect(again.ok).toBe(true);
    expect(again.headers['RateLimit-Remaining']).toBe('0');
  });

  it('clients are counted separately', async () => {
    const { call } = setup(1);
    await call(ALICE);
    expect((await call(ALICE)).ok).toBe(false);
    const bob = await call(BOB);
    expect(bob.ok).toBe(true);
    expect(bob.headers['RateLimit-Remaining']).toBe('0');
  });

  it('a public route is not counted and gets no rate-limit headers', async () => {
    const { kv, call } = setup(1);
    const result = await call(undefined, route({ [IS_PUBLIC]: true }));
    expect(result.ok).toBe(true);
    expect(result.headers).toEqual({});
    expect(kv.counters.size).toBe(0);
  });

  it('a request with no client (the auth guard refused it) is not counted', async () => {
    const { kv, call } = setup(1);
    await call(undefined);
    expect(kv.counters.size).toBe(0);
  });

  it('Redis unreachable -> 503 with the fixed body', async () => {
    const { kv, call } = setup();
    kv.limiterDown = true;
    const result = await call(ALICE);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.getStatus()).toBe(503);
    expect(result.error.getResponse()).toEqual({ detail: RATE_LIMIT_UNAVAILABLE });
    expect(result.headers['RateLimit-Limit']).toBeUndefined();
  });

  it('Redis hanging -> 503 within the timeout, never a hang', async () => {
    const queue = new FakeQueue();
    queue.mode = 'hang';
    queue.kv.eval = () => new Promise<never>(() => undefined);
    const guard = new RateLimitGuard(
      new Reflector(),
      config({ RATE_LIMIT_PER_MINUTE: 3 }),
      queue.kv,
      new TriageQueueService(queue as QueueLike, 50),
      60,
    );
    const started = Date.now();
    await expect(guard.canActivate(context(route(), { principal: ALICE }).ctx)).rejects.toMatchObject({
      response: { detail: RATE_LIMIT_UNAVAILABLE },
    });
    expect(Date.now() - started).toBeLessThan(250);
  });
});
