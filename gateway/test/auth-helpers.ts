import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { vi } from 'vitest';
import { hashKey } from '../src/auth/client-key.js';
import type { RegisteredClient } from '../src/auth/auth.types.js';

/**
 * Fixed, made-up keys for the tests. They are not real keys and are in no registry anywhere
 * but the one the tests build below.
 */
export const TEST_KEYS = {
  alice: 'tiq_test-key-alice-0000000000000000000000000',
  bob: 'tiq_test-key-bob-000000000000000000000000000',
  ops: 'tiq_test-key-ops-000000000000000000000000000',
} as const;

/** The browser origin the tests allow (ALLOWED_ORIGINS). */
export const TEST_ORIGIN = 'http://localhost:5173';

export type TestClient = keyof typeof TEST_KEYS;

/** Two submitters and one reviewer. */
export const TEST_REGISTRY: RegisteredClient[] = [
  { name: 'alice', role: 'submitter', key_sha256: hashKey(TEST_KEYS.alice) },
  { name: 'bob', role: 'submitter', key_sha256: hashKey(TEST_KEYS.bob) },
  { name: 'ops', role: 'reviewer', key_sha256: hashKey(TEST_KEYS.ops) },
];

/** The registry and a limit high enough that tests which poll a lot are never limited. */
/** Stands in for Python's REVIEW_API_KEY in tests. Not a real key. */
export const TEST_REVIEW_KEY = 'test-review-key-not-real-0000';

export function stubAuthEnv(rateLimitPerMinute = '10000') {
  vi.stubEnv('TRIAGE_REVIEW_API_KEY', TEST_REVIEW_KEY);
  vi.stubEnv('ALLOWED_ORIGINS', TEST_ORIGIN);
  // Every login and session setting, stated explicitly. The config loader also reads a local gateway/.env
  // (a developer's real settings, such as COOKIE_SECURE=false for http), and a test must never depend on it.
  vi.stubEnv('SESSION_IDLE_MINUTES', '60');
  vi.stubEnv('SESSION_ABSOLUTE_HOURS', '8');
  vi.stubEnv('COOKIE_SECURE', 'true');
  vi.stubEnv('LOGIN_MAX_FAILURES_PER_IP', '20');
  vi.stubEnv('LOGIN_MAX_FAILURES_PER_EMAIL', '5');
  vi.stubEnv('LOGIN_WINDOW_MINUTES', '15');
  vi.stubEnv('TRUST_PROXY', 'false');
  // The public form is off unless a test turns it on; its other settings are stated so a local gateway/.env cannot leak in.
  vi.stubEnv('PUBLIC_FORM_ENABLED', 'false');
  vi.stubEnv('TURNSTILE_SECRET_KEY', '');
  vi.stubEnv('TURNSTILE_VERIFY_URL', 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  vi.stubEnv('TURNSTILE_EXPECTED_HOSTNAMES', '');
  vi.stubEnv('TURNSTILE_EXPECTED_ACTION', '');
  vi.stubEnv('PUBLIC_MAX_PER_IP_PER_HOUR', '5');
  vi.stubEnv('PUBLIC_DAILY_CAP', '200');
  vi.stubEnv('GATEWAY_CLIENTS', JSON.stringify(TEST_REGISTRY));
  vi.stubEnv('RATE_LIMIT_PER_MINUTE', rateLimitPerMinute);
}

export const bearer = (who: TestClient) => `Bearer ${TEST_KEYS[who]}`;

/**
 * supertest for an app, with the Authorization header of `who` already set. Defaults to the
 * reviewer "ops", who may call everything, so tests that are not about roles read as before.
 */
export function api(app: INestApplication, who: TestClient = 'ops') {
  const http = request(app.getHttpServer());
  return {
    get: (url: string) => http.get(url).set('Authorization', bearer(who)),
    post: (url: string) => http.post(url).set('Authorization', bearer(who)),
  };
}
