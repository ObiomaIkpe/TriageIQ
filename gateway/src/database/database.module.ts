import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type pg from 'pg';
import type { AppConfig } from '../config/env.schema.js';
import { PG_POOL } from './database.constants.js';
import { createPool } from './pool.js';

const logger = new Logger('Database');

/** Longest app.close() waits for the pool to close. It must never hang the shutdown. */
const CLOSE_WAIT_MS = 2000;

/**
 * The gateway's own Postgres pool (max 10 connections, 2 s connect timeout, 5 s statement
 * timeout). It connects lazily, so the app starts even while the database is down; /ready then
 * reports it.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const pool = createPool(config.get('GATEWAY_DATABASE_URL', { infer: true }));
        // Without a listener, an error on an idle connection would crash the process.
        pool.on('error', (error: NodeJS.ErrnoException) => {
          logger.warn(`Database connection problem (${error.code ?? error.name})`);
        });
        return pool;
      },
    },
  ],
  exports: [PG_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async onApplicationShutdown(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      // pool.end() waits for connections that are in use; bound it so shutdown cannot hang
      // (the same lesson as the Redis worker).
      await Promise.race([
        this.pool.end(),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLOSE_WAIT_MS);
        }),
      ]);
    } catch {
      // closing is best effort
    } finally {
      clearTimeout(timer);
    }
  }
}
