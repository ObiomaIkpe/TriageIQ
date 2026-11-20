import { getQueueToken } from '@nestjs/bullmq';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { QUEUE_TIMEOUT_MS, TRIAGE_QUEUE } from '../src/queue/queue.constants.js';
import { REDIS_CLIENT } from '../src/redis/redis.constants.js';
import type { FakeQueue } from './fake-queue.js';

/** Valid settings for the app. Call before loading the app module. */
export function stubEnv(redisUrl = 'redis://localhost:6379') {
  vi.stubEnv('PORT', '3000');
  vi.stubEnv('REDIS_URL', redisUrl);
  vi.stubEnv('TRIAGE_SERVICE_URL', 'http://localhost:8000');
}

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
): Promise<NestExpressApplication> {
  // Loaded here so the environment is set first (the config is checked when the module loads).
  const { AppModule } = await import('../src/app.module.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(REDIS_CLIENT)
    .useValue(fakeRedisClient)
    .overrideProvider(getQueueToken(TRIAGE_QUEUE))
    .useValue(queue)
    .overrideProvider(QUEUE_TIMEOUT_MS)
    .useValue(timeoutMs)
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureApp(app);
  await app.init();
  return app;
}
