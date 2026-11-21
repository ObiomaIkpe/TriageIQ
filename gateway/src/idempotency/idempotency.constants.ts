/** Injection token for the Redis connection that holds the idempotency keys. */
export const IDEMPOTENCY_REDIS = Symbol('IDEMPOTENCY_REDIS');

/** The few Redis commands the idempotency keys use (ioredis has all of them). */
export interface KeyValueClient {
  /** ioredis: 'ready' when the connection is up. Anything else fails fast instead of waiting. */
  readonly status: string;
  set(key: string, value: string, expiry: 'EX', seconds: number, mode: 'NX'): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}
