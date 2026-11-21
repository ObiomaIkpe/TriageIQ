import { Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { AppConfig } from '../config/env.schema.js';
import { QueueModule } from '../queue/queue.module.js';
import { IDEMPOTENCY_REDIS } from './idempotency.constants.js';
import { IdempotencyService } from './idempotency.service.js';

const logger = new Logger('IdempotencyRedis');

/**
 * Builds the connection for the idempotency keys. It is its own connection, made with
 * public ioredis API only (BullMQ 6 keeps its client on an internal object). With
 * enableOfflineQueue off, a command sent while Redis is down fails at once instead of waiting
 * in memory, so a write can never go out late, after the caller was told 503.
 */
export function createIdempotencyRedis(url: string): Redis {
  const client = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });
  client.on('error', (error: NodeJS.ErrnoException) => {
    // A short code only, never the URL (it can hold a password).
    logger.warn(`Redis connection problem (${error.code ?? error.name})`);
  });
  return client;
}

@Module({
  imports: [QueueModule],
  providers: [
    {
      provide: IDEMPOTENCY_REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        createIdempotencyRedis(config.get('REDIS_URL', { infer: true })),
    },
    IdempotencyService,
  ],
  // The token is exported because the rate limiter counts on the same connection.
  exports: [IdempotencyService, IDEMPOTENCY_REDIS],
})
export class IdempotencyModule implements OnApplicationShutdown {
  constructor(@Inject(IDEMPOTENCY_REDIS) private readonly client: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.client.status === 'ready') {
      try {
        await this.client.quit();
        return;
      } catch {
        // fall through to a hard close
      }
    }
    this.client.disconnect();
  }
}
