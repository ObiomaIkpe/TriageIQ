import {
  Global,
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { AppConfig } from '../config/env.schema.js';
import { REDIS_CLIENT } from './redis.constants.js';

const logger = new Logger('Redis');

/**
 * Builds the client. ioredis connects in the background and keeps retrying, so
 * the app starts even when Redis is briefly down. The 'error' listener stops
 * connection errors from being thrown as unhandled events. It logs only a
 * short code, never the URL (which could hold a password).
 */
export function createRedisClient(url: string): Redis {
  const client = new Redis(url, {
    // A command fails after one reconnect attempt instead of queueing for minutes.
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });
  client.on('error', (error: NodeJS.ErrnoException) => {
    logger.warn(`Redis connection problem (${error.code ?? error.name})`);
  });
  return client;
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) =>
        createRedisClient(config.get('REDIS_URL', { infer: true })),
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  /** Closes the connection when the app shuts down (needs enableShutdownHooks). */
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
