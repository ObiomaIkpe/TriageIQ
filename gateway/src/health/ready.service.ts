import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/env.schema.js';
import { PG_POOL } from '../database/database.constants.js';
import { REDIS_CLIENT } from '../redis/redis.constants.js';
import { FETCH, READY_TIMEOUT_MS } from './health.constants.js';

/** The only thing /ready needs from the Redis client. */
export interface Pingable {
  ping(): Promise<string>;
}

/** The only thing /ready needs from the Postgres pool. */
export interface Queryable {
  query(text: string): Promise<unknown>;
}

export type CheckName = 'redis' | 'triage' | 'postgres';

export interface ReadyReport {
  ready: boolean;
  body: {
    status: 'ready' | 'not_ready';
    checks: Record<CheckName, 'ok' | 'down'>;
    /** Only present when something is down: a short, fixed-vocabulary reason per failing check. */
    reasons?: Partial<Record<CheckName, string>>;
  };
}

type Outcome = { ok: true } | { ok: false; reason: string };

class CheckTimeout extends Error {}

/** Turns an error into a short reason that is safe to return (no URLs, no stack). */
function reasonFor(error: unknown): string {
  if (error instanceof CheckTimeout) return 'timeout';
  const e = error as { name?: string; code?: string; cause?: { code?: string } } | null;
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'timeout';
  const code = e?.code ?? e?.cause?.code;
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found';
  // Postgres error codes: 28xxx is a login problem, 3D000 a missing database.
  if (code === '28P01' || code === '28000') return 'authentication failed';
  if (code === '3D000') return 'database not found';
  return 'unreachable';
}

@Injectable()
export class ReadyService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Pingable,
    @Inject(ConfigService) private readonly config: ConfigService<AppConfig, true>,
    @Inject(FETCH) private readonly fetchFn: typeof fetch,
    @Inject(READY_TIMEOUT_MS) private readonly timeoutMs: number,
    @Inject(PG_POOL) private readonly db: Queryable,
  ) {}

  /** Runs the three checks in parallel; each one has its own timeout. */
  async check(): Promise<ReadyReport> {
    const [redis, triage, postgres] = await Promise.all([
      this.checkRedis(),
      this.checkTriage(),
      this.checkPostgres(),
    ]);
    const checks: ReadyReport['body']['checks'] = {
      redis: redis.ok ? 'ok' : 'down',
      triage: triage.ok ? 'ok' : 'down',
      postgres: postgres.ok ? 'ok' : 'down',
    };
    const reasons: Partial<Record<CheckName, string>> = {};
    if (!redis.ok) reasons.redis = redis.reason;
    if (!triage.ok) reasons.triage = triage.reason;
    if (!postgres.ok) reasons.postgres = postgres.reason;

    const ready = redis.ok && triage.ok && postgres.ok;
    return {
      ready,
      body: ready
        ? { status: 'ready', checks }
        : { status: 'not_ready', checks, reasons },
    };
  }

  private async checkRedis(): Promise<Outcome> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CheckTimeout()), this.timeoutMs);
      });
      // ping() cannot be cancelled, so race it. A late rejection is swallowed below.
      const ping = this.redis.ping();
      ping.catch(() => undefined);
      await Promise.race([ping, timeout]);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: reasonFor(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async checkPostgres(): Promise<Outcome> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CheckTimeout()), this.timeoutMs);
      });
      // The query cannot be cancelled from here, so race it. A late rejection is swallowed.
      const query = this.db.query('SELECT 1');
      query.catch(() => undefined);
      await Promise.race([query, timeout]);
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: reasonFor(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async checkTriage(): Promise<Outcome> {
    const base = this.config.get('TRIAGE_SERVICE_URL', { infer: true });
    const url = `${base.replace(/\/+$/, '')}/ready`;
    try {
      const response = await this.fetchFn(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // Only the status code matters. Drop the body so the connection is freed.
      await response.body?.cancel();
      if (!response.ok) return { ok: false, reason: `status ${response.status}` };
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: reasonFor(error) };
    }
  }
}
