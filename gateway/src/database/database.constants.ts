/** Injection token for the pg Pool of the gateway's own database. */
export const PG_POOL = Symbol('PG_POOL');

/** The small part of a pg Pool the app code uses, so tests can pass a fake. */
export interface DbPool {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
  connect(): Promise<DbClient>;
}

export interface DbClient {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
  release(error?: Error | boolean): void;
}
