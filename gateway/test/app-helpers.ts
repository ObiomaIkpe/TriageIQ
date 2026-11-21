import { getQueueToken } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { vi } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { IDEMPOTENCY_REDIS } from '../src/idempotency/idempotency.constants.js';
import { PG_POOL } from '../src/database/database.constants.js';
import { QUEUE_TIMEOUT_MS, TRIAGE_QUEUE } from '../src/queue/queue.constants.js';
import { REDIS_CLIENT } from '../src/redis/redis.constants.js';
import { WorkerModule } from '../src/worker/worker.module.js';
import { stubAuthEnv } from './auth-helpers.js';
import type { FakeQueue } from './fake-queue.js';

/** Valid settings for the app. Call before loading the app module. */
export function stubEnv(redisUrl = 'redis://localhost:6379') {
  vi.stubEnv('PORT', '3000');
  vi.stubEnv('REDIS_URL', redisUrl);
  vi.stubEnv('TRIAGE_SERVICE_URL', 'http://localhost:8000');
  // Never connected to in these tests: the pool is lazy, or replaced by a fake.
  vi.stubEnv('GATEWAY_DATABASE_URL', 'postgresql://gateway:test-password@localhost:5432/gateway_test');
  stubAuthEnv();
}

/** Stands in for WorkerModule, so a test that only checks intake never runs a worker. */
@Module({})
export class NoWorkerModule {}

/** Stands in for the gateway database pool: answers SELECT 1 and closes at once. An INSERT ... RETURNING (a ticket
 * reference reservation) gets one row back, i.e. "reserved". Specs that run the real app against a real Redis use this too. */
export const fakeGatewayDb = {
  query: async () => ({ rows: [{ '?column?': 1 }], rowCount: 1 }),
  connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => undefined }),
  end: async () => undefined,
  on: () => undefined,
};

const fakeRedisClient = {
  ping: async () => 'PONG',
  status: 'ready',
  quit: async () => 'OK',
  disconnect: () => undefined,
};

/** The real app (real modules, real body-parser setup) with a fake queue and a fake Redis client. */
export async function startAppWithFakeQueue(
  queue: FakeQueue,
  timeoutMs = 100,
  customize: (builder: TestingModuleBuilder) => TestingModuleBuilder = (builder) => builder,
): Promise<NestExpressApplication> {
  // Loaded here so the environment is set first (the config is checked when the module loads).
  const { AppModule } = await import('../src/app.module.js');
  // The fake gateway database goes first, so a test's own `customize` can replace it (the last override wins).
  const moduleRef = await customize(Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PG_POOL).useValue(fakeGatewayDb))
    .overrideProvider(REDIS_CLIENT)
    .useValue(fakeRedisClient)
    .overrideProvider(getQueueToken(TRIAGE_QUEUE))
    .useValue(queue)
    .overrideProvider(IDEMPOTENCY_REDIS)
    .useValue(queue.kv)
    .overrideProvider(QUEUE_TIMEOUT_MS)
    .useValue(timeoutMs)
    .overrideModule(WorkerModule)
    .useModule(NoWorkerModule)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app);
  await app.init();
  return app;
}
