import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/database/migrate.js';
import { createPool } from '../src/database/pool.js';
import { ReferenceService, ReferenceUnavailableError } from '../src/tickets/reference.service.js';

/**
 * Reference reservation against a REAL Postgres: migration 002 and the INSERT ... ON CONFLICT DO NOTHING RETURNING.
 * Skipped unless GATEWAY_TEST_DATABASE_URL is set; refuses a database whose name does not end in "_test" because it
 * DROPS the public schema first (same as database.pg.e2e-spec.ts).
 */
const URL_ = process.env.GATEWAY_TEST_DATABASE_URL;
if (URL_ && !/\/[^/?]*_test(\?.*)?$/.test(URL_)) {
  throw new Error('GATEWAY_TEST_DATABASE_URL must name a database whose name ends in _test');
}

describe.skipIf(!URL_)('reference reservation (real Postgres)', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = createPool(URL_ as string, { statementTimeoutMs: 0, max: 10 });
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migrate(pool, DEFAULT_MIGRATIONS_DIR);
  });
  const sequence = (...refs: string[]) => {
    let i = 0;
    return () => refs[Math.min(i++, refs.length - 1)];
  };

  it('migration 002 makes ticket_references with the reference as the primary key', async () => {
    const cols = await pool.query("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'ticket_references' ORDER BY ordinal_position");
    expect(cols.rows).toEqual([
      { column_name: 'reference', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'created_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
    ]);
    const pk = await pool.query("SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = 'ticket_references'::regclass AND i.indisprimary");
    expect(pk.rows).toEqual([{ attname: 'reference' }]);
    expect(path.basename(DEFAULT_MIGRATIONS_DIR)).toBe('migrations');
  });

  it('re-running the migrations changes nothing', async () => {
    const again = await migrate(pool, DEFAULT_MIGRATIONS_DIR);
    expect(again.applied).toEqual([]);
  });

  it('a free reference is stored once; a taken one makes the service move on to a new one', async () => {
    const service = new ReferenceService(pool as never, sequence('TKT-BBBBBB'));
    expect(await service.reserve('TKT-AAAAAA')).toBe('TKT-AAAAAA');
    expect(await service.reserve('TKT-AAAAAA')).toBe('TKT-BBBBBB'); // collision on the real primary key, then the next
    const rows = await pool.query('SELECT reference FROM ticket_references ORDER BY reference');
    expect(rows.rows.map((r) => r.reference)).toEqual(['TKT-AAAAAA', 'TKT-BBBBBB']);
  });

  it('five collisions in a row: ReferenceUnavailableError, and nothing was added', async () => {
    await pool.query("INSERT INTO ticket_references (reference) VALUES ('TKT-AAAAAA')");
    const service = new ReferenceService(pool as never, sequence('TKT-AAAAAA'));
    await expect(service.reserve('TKT-AAAAAA')).rejects.toBeInstanceOf(ReferenceUnavailableError);
    expect((await pool.query('SELECT count(*)::int AS n FROM ticket_references')).rows[0].n).toBe(1);
  });

  it('50 concurrent reservations of the SAME candidate all end up with different references', async () => {
    let n = 0;
    const service = new ReferenceService(pool as never, () => `TKT-G${String((n += 1)).padStart(5, '0')}`);
    const got = await Promise.all(Array.from({ length: 50 }, () => service.reserve('TKT-AAAAAA')));
    expect(new Set(got).size).toBe(50);
    expect((await pool.query('SELECT count(*)::int AS n FROM ticket_references')).rows[0].n).toBe(50);
  });

  it('a database failure is ReferenceUnavailableError', async () => {
    await pool.query('DROP TABLE ticket_references');
    await expect(new ReferenceService(pool as never, () => 'TKT-AAAAAA').reserve()).rejects.toBeInstanceOf(ReferenceUnavailableError);
  });
});
