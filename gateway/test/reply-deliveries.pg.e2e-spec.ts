import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_MIGRATIONS_DIR, migrate } from '../src/database/migrate.js';
import { createPool } from '../src/database/pool.js';
import { ReplyDeliveryRepository } from '../src/mail/reply-delivery.repository.js';

/**
 * Migration 003 and the delivery repository against a REAL Postgres. Skipped unless GATEWAY_TEST_DATABASE_URL is set; refuses a
 * database whose name does not end in "_test" (it DROPS the public schema first).
 */
const URL_ = process.env.GATEWAY_TEST_DATABASE_URL;
if (URL_ && !/\/[^/?]*_test(\?.*)?$/.test(URL_)) throw new Error('GATEWAY_TEST_DATABASE_URL must name a database whose name ends in _test');

const A = '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34';
const B = '00000000-0000-4000-8000-000000000002';

describe.skipIf(!URL_)('reply_deliveries (real Postgres)', () => {
  let pool: pg.Pool;
  let repo: ReplyDeliveryRepository;
  beforeAll(() => {
    pool = createPool(URL_ as string, { statementTimeoutMs: 0, max: 6 });
    repo = new ReplyDeliveryRepository(pool as never);
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migrate(pool, DEFAULT_MIGRATIONS_DIR);
  });

  it('migration 003 makes the table: ticket_id is the primary key and there is NO column for an address or a text', async () => {
    const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'reply_deliveries' ORDER BY ordinal_position");
    expect(cols.rows.map((r) => r.column_name)).toEqual(['ticket_id', 'reference', 'status', 'attempts', 'last_error', 'queued_at', 'sent_at', 'updated_at']);
    const pk = await pool.query("SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = 'reply_deliveries'::regclass AND i.indisprimary");
    expect(pk.rows).toEqual([{ attname: 'ticket_id' }]);
  });

  it('the database refuses a status outside the four, and a negative attempt count', async () => {
    await expect(pool.query("INSERT INTO reply_deliveries (ticket_id, reference, status) VALUES ($1, 'TKT-AAAAAA', 'weird')", [A])).rejects.toThrow(/status_check/);
    await expect(pool.query("INSERT INTO reply_deliveries (ticket_id, reference, status, attempts) VALUES ($1, 'TKT-AAAAAA', 'queued', -1)", [A])).rejects.toThrow(/attempts_check/);
  });

  it('insert is once per ticket (ON CONFLICT DO NOTHING): a second insert changes nothing', async () => {
    expect(await repo.insert(A, 'TKT-AAAAAA', 'queued')).toBe(true);
    expect(await repo.insert(A, 'TKT-AAAAAA', 'skipped_no_email')).toBe(false);
    expect((await repo.get(A))?.status).toBe('queued');
  });

  it('50 concurrent inserts for one ticket: exactly one wins', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => repo.insert(A, 'TKT-AAAAAA', 'queued')));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('the life of a delivery: attempts counted, then sent; a later failure cannot overwrite sent', async () => {
    await repo.insert(A, 'TKT-AAAAAA', 'queued');
    expect(await repo.startAttempt(A)).toBe(1);
    await repo.noteError(A, 'mail server busy, try again later');
    expect(await repo.startAttempt(A)).toBe(2);
    await repo.markSent(A);
    await repo.markFailed(A, 'late failure'); // names the status it expects (queued): no effect
    const row = await repo.get(A);
    expect(row).toMatchObject({ status: 'sent', attempts: 2, last_error: null });
    expect(row?.sent_at).toBeInstanceOf(Date);
    expect(await repo.startAttempt(A)).toBeUndefined(); // no more tries once sent
  });

  it('failed -> retry resets to queued with zero attempts; only a failed row can be reset', async () => {
    await repo.insert(A, 'TKT-AAAAAA', 'queued');
    expect(await repo.resetFailed(A)).toBe(false);
    await repo.startAttempt(A);
    await repo.markFailed(A, 'recipient daily limit');
    expect(await repo.get(A)).toMatchObject({ status: 'failed', last_error: 'recipient daily limit' });
    expect(await repo.resetFailed(A)).toBe(true);
    expect(await repo.get(A)).toMatchObject({ status: 'queued', attempts: 0, last_error: null, sent_at: null });
  });

  it('deleteUntried removes a row that was never tried, but not one that was', async () => {
    await repo.insert(A, 'TKT-AAAAAA', 'queued');
    await repo.insert(B, 'TKT-AAAAAB', 'queued');
    await repo.startAttempt(B);
    await repo.deleteUntried(A);
    await repo.deleteUntried(B);
    expect(await repo.get(A)).toBeUndefined();
    expect(await repo.get(B)).toBeDefined();
  });

  it('existing() and staleQueued()', async () => {
    await repo.insert(A, 'TKT-AAAAAA', 'queued');
    expect(await repo.existing([A, B])).toEqual(new Set([A]));
    expect(await repo.existing([])).toEqual(new Set());
    expect(await repo.staleQueued(60_000)).toEqual([]);
    await pool.query("UPDATE reply_deliveries SET queued_at = now() - interval '1 hour'");
    expect(await repo.staleQueued(60_000)).toEqual([{ ticket_id: A, reference: 'TKT-AAAAAA' }]);
  });
});
