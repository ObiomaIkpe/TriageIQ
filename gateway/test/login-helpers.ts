import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { vi } from 'vitest';
import { COUNTER_STORE } from '../src/auth/login-limiter.js';
import { FETCH } from '../src/health/health.constants.js';
import { SESSION_CLOCK, SESSION_STORE } from '../src/sessions/session.constants.js';
import { PasswordHasher } from '../src/users/password-hasher.js';
import { UsersRepository } from '../src/users/users.repository.js';
import { startAppWithFakeQueue } from './app-helpers.js';
import { TEST_ORIGIN } from './auth-helpers.js';
import { FakeQueue } from './fake-queue.js';
import { FakeClock, MemoryCounterStore, MemorySessionStore, MemoryUsers } from './memory-stores.js';

export const PASSWORD = 'a long and unusual passphrase';
export const EMAIL = 'ada@example.com';
export const OTHER_PASSWORD = 'a completely different passphrase';

/** What the fake Python service answers to every passthrough call: an empty list. */
export const fakeFetch = (async () =>
  new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

/**
 * The real app with a real PasswordHasher but in-memory sessions, counters and users, and a clock the
 * test moves. Seeds two reviewers: ada (enabled) and off (disabled), both with PASSWORD.
 */
export async function startLoginApp() {
  const clock = new FakeClock();
  const users = new MemoryUsers(clock);
  const sessionStore = new MemorySessionStore(clock);
  const counters = new MemoryCounterStore(clock);
  const queue = new FakeQueue();
  const hasher = new PasswordHasher();
  const hash = await hasher.hash(PASSWORD);
  const ada = users.add({ email: EMAIL, passwordHash: hash, displayName: 'Ada Lovelace' });
  const off = users.add({ email: 'off@example.com', passwordHash: hash, displayName: 'Off', disabled: true });

  const app: NestExpressApplication = await startAppWithFakeQueue(queue, 100, (builder) =>
    builder
      .overrideProvider(SESSION_CLOCK)
      .useValue(clock.fn)
      .overrideProvider(SESSION_STORE)
      .useValue(sessionStore)
      .overrideProvider(COUNTER_STORE)
      .useValue(counters)
      .overrideProvider(UsersRepository)
      .useValue(users)
      .overrideProvider(FETCH)
      .useValue(fakeFetch),
  );
  const verify = vi.spyOn(app.get(PasswordHasher, { strict: false }), 'verify');
  return { app, clock, users, sessionStore, counters, queue, ada, off, verify, hash, http: () => request(app.getHttpServer()) };
}

export type LoginApp = Awaited<ReturnType<typeof startLoginApp>>;

/** POST /auth/login with the allowed Origin. */
export function login(
  world: LoginApp,
  body: Record<string, unknown> = { email: EMAIL, password: PASSWORD },
  extra: { origin?: string | null; cookie?: string; forwardedFor?: string } = {},
) {
  const req = world.http().post('/auth/login').set('Content-Type', 'application/json');
  if (extra.origin !== null) req.set('Origin', extra.origin ?? TEST_ORIGIN);
  if (extra.cookie) req.set('Cookie', extra.cookie);
  if (extra.forwardedFor) req.set('X-Forwarded-For', extra.forwardedFor);
  return req.send(body);
}

/** The "tiq_session=<token>" pair from a Set-Cookie header, or undefined. */
export function cookieOf(response: { headers: Record<string, unknown> }): string | undefined {
  const header = response.headers['set-cookie'] as string[] | undefined;
  const line = header?.find((entry) => entry.startsWith('tiq_session='));
  return line?.split(';')[0];
}

export const tokenOf = (cookie: string) => cookie.slice('tiq_session='.length);

/** A request that carries the cookie (and, for writes, the allowed Origin). */
export function withCookie(world: LoginApp, cookie: string) {
  const http = world.http();
  return {
    get: (url: string) => http.get(url).set('Cookie', cookie),
    post: (url: string, origin: string | null = TEST_ORIGIN) => {
      const req = http.post(url).set('Cookie', cookie);
      if (origin !== null) req.set('Origin', origin);
      return req;
    },
  };
}
