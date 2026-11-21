import { ConfigService } from '@nestjs/config';
import { vi } from 'vitest';
import { ReadyService, type Pingable, type Queryable } from './ready.service.js';

const config = {
  get: () => 'http://triage.internal:8000/',
} as unknown as ConfigService<never, true>;

const redisOk: Pingable = { ping: async () => 'PONG' };
const redisRefused: Pingable = {
  ping: async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:6379'), { code: 'ECONNREFUSED' });
  },
};
const redisHangs: Pingable = { ping: () => new Promise(() => undefined) };

const fetchStatus = (status: number) =>
  vi.fn(async () => new Response(null, { status })) as unknown as typeof fetch;

/** A fetch that only finishes when its abort signal fires, like the real one. */
const fetchHangs = vi.fn(
  (_url: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }),
) as unknown as typeof fetch;

const fetchRefused = vi.fn(async () => {
  throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
}) as unknown as typeof fetch;

const pgOk: Queryable = { query: async () => ({ rows: [{ '?column?': 1 }] }) };
const pgRefused: Queryable = {
  query: async () => {
    throw Object.assign(new Error('connect ECONNREFUSED 10.4.5.6:5432'), { code: 'ECONNREFUSED' });
  },
};
const pgHangs: Queryable = { query: () => new Promise(() => undefined) };

const make = (redis: Pingable, fetchFn: typeof fetch, pg: Queryable = pgOk) =>
  new ReadyService(redis, config, fetchFn, 30, pg);

describe('ReadyService', () => {
  it('all three ok -> ready', async () => {
    const fetchFn = fetchStatus(200);
    const report = await make(redisOk, fetchFn).check();

    expect(report.ready).toBe(true);
    expect(report.body).toEqual({ status: 'ready', checks: { redis: 'ok', triage: 'ok', postgres: 'ok' } });
    expect(fetchFn).toHaveBeenCalledWith('http://triage.internal:8000/ready', expect.anything());
  });

  it('redis down -> not ready, reason connection refused', async () => {
    const report = await make(redisRefused, fetchStatus(200)).check();

    expect(report.ready).toBe(false);
    expect(report.body).toEqual({
      status: 'not_ready',
      checks: { redis: 'down', triage: 'ok', postgres: 'ok' },
      reasons: { redis: 'connection refused' },
    });
  });

  it('redis that never answers -> timeout', async () => {
    const report = await make(redisHangs, fetchStatus(200)).check();

    expect(report.body.checks).toEqual({ redis: 'down', triage: 'ok', postgres: 'ok' });
    expect(report.body.reasons).toEqual({ redis: 'timeout' });
  });

  it('python down (connection refused) -> not ready', async () => {
    const report = await make(redisOk, fetchRefused).check();

    expect(report.ready).toBe(false);
    expect(report.body).toEqual({
      status: 'not_ready',
      checks: { redis: 'ok', triage: 'down', postgres: 'ok' },
      reasons: { triage: 'connection refused' },
    });
  });

  it('python returns 503 -> not ready, reason status 503', async () => {
    const report = await make(redisOk, fetchStatus(503)).check();

    expect(report.ready).toBe(false);
    expect(report.body).toEqual({
      status: 'not_ready',
      checks: { redis: 'ok', triage: 'down', postgres: 'ok' },
      reasons: { triage: 'status 503' },
    });
  });

  it('python times out -> not ready, reason timeout', async () => {
    const report = await make(redisOk, fetchHangs).check();

    expect(report.ready).toBe(false);
    expect(report.body.checks).toEqual({ redis: 'ok', triage: 'down', postgres: 'ok' });
    expect(report.body.reasons).toEqual({ triage: 'timeout' });
  });

  it('both down -> both reported', async () => {
    const report = await make(redisRefused, fetchStatus(500)).check();

    expect(report.body.checks).toEqual({ redis: 'down', triage: 'down', postgres: 'ok' });
    expect(report.body.reasons).toEqual({ redis: 'connection refused', triage: 'status 500' });
  });

  it('runs the two checks in parallel', async () => {
    const started = Date.now();
    await make(redisHangs, fetchHangs).check();
    // Both hang for the 30 ms timeout. In series this would take about 60 ms.
    expect(Date.now() - started).toBeLessThan(55);
  });

  it('runs the three checks in parallel (a hanging Postgres costs one timeout, not two)', async () => {
    const started = Date.now();
    await make(redisHangs, fetchHangs, pgHangs).check();
    expect(Date.now() - started).toBeLessThan(55);
  });

  it('never leaks internal URLs, addresses or stack traces', async () => {
    const reports = await Promise.all([
      make(redisRefused, fetchRefused).check(),
      make(redisHangs, fetchHangs).check(),
      make(redisOk, fetchStatus(503)).check(),
      make(redisOk, fetchStatus(200), pgRefused).check(),
      make(redisOk, fetchStatus(200), pgHangs).check(),
    ]);
    for (const { body } of reports) {
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/triage\.internal|10\.1\.2\.3|10\.4\.5\.6|http|\bat\s|\.ts/);
    }
  });

  describe('postgres', () => {
    it('SELECT 1 is the check', async () => {
      const query = vi.fn(async () => ({ rows: [] }));
      await make(redisOk, fetchStatus(200), { query }).check();
      expect(query).toHaveBeenCalledWith('SELECT 1');
    });

    it('postgres down -> not ready, reason connection refused, the others still ok', async () => {
      const report = await make(redisOk, fetchStatus(200), pgRefused).check();
      expect(report.ready).toBe(false);
      expect(report.body).toEqual({
        status: 'not_ready',
        checks: { redis: 'ok', triage: 'ok', postgres: 'down' },
        reasons: { postgres: 'connection refused' },
      });
    });

    it('a postgres that never answers -> timeout', async () => {
      const report = await make(redisOk, fetchStatus(200), pgHangs).check();
      expect(report.body.checks).toEqual({ redis: 'ok', triage: 'ok', postgres: 'down' });
      expect(report.body.reasons).toEqual({ postgres: 'timeout' });
    });

    it.each([
      ['28P01', 'authentication failed'],
      ['28000', 'authentication failed'],
      ['3D000', 'database not found'],
      ['ENOTFOUND', 'host not found'],
      ['57P01', 'unreachable'],
    ])('the postgres error code %s -> reason "%s" (a fixed phrase, never the message)', async (code, reason) => {
      const pg: Queryable = {
        query: async () => {
          throw Object.assign(new Error('password authentication failed for user "gateway" at 10.4.5.6'), { code });
        },
      };
      const report = await make(redisOk, fetchStatus(200), pg).check();
      expect(report.body.reasons).toEqual({ postgres: reason });
    });

    it('all three down -> all three reported', async () => {
      const report = await make(redisRefused, fetchStatus(500), pgRefused).check();
      expect(report.body.checks).toEqual({ redis: 'down', triage: 'down', postgres: 'down' });
    });
  });
});
