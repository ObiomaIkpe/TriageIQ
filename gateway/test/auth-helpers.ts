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
