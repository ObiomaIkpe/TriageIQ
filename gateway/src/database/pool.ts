import pg from 'pg';

export interface PoolOptions {
  /** Longest a single statement may run, in ms. 0 turns the limit off (migrations). */
  statementTimeoutMs?: number;
  max?: number;
}

/**
 * Builds the pool for the gateway's database. It connects lazily, so creating it needs no
 * database. Connection problems are logged as a short code by the caller's 'error' listener:
 * the URL holds a password and is never put in a message.
 */
export function createPool(connectionString: string, options: PoolOptions = {}): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30_000,
    statement_timeout: options.statementTimeoutMs ?? 5000,
    application_name: 'triageiq-gateway',
  });
}
