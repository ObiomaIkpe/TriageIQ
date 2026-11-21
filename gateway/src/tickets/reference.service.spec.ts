import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_RESERVE_TRIES, ReferenceService, ReferenceUnavailableError } from './reference.service.js';

/** A pool whose table is a Set: INSERT ... ON CONFLICT DO NOTHING RETURNING, like Postgres. */
function fakePool(taken: string[] = []) {
  const table = new Set(taken);
  const tried: string[] = [];
  return {
    table,
    tried,
    query: async (_sql: string, values: unknown[]) => {
      const ref = values[0] as string;
      tried.push(ref);
      if (table.has(ref)) return { rows: [], rowCount: 0 };
      table.add(ref);
      return { rows: [{ reference: ref }], rowCount: 1 };
    },
  };
}
const sequence = (...refs: string[]) => {
  let i = 0;
  return () => refs[Math.min(i++, refs.length - 1)];
};

describe('ReferenceService.reserve', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reserves a free candidate with one insert', async () => {
    const pool = fakePool();
    expect(await new ReferenceService(pool as never, sequence('TKT-BBBBBB')).reserve('TKT-AAAAAA')).toBe('TKT-AAAAAA');
    expect(pool.tried).toEqual(['TKT-AAAAAA']);
  });

  it('with no candidate, makes one', async () => {
    const pool = fakePool();
    expect(await new ReferenceService(pool as never, sequence('TKT-BBBBBB')).reserve()).toBe('TKT-BBBBBB');
  });

  it('a collision tries again with a new reference', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const pool = fakePool(['TKT-AAAAAA', 'TKT-BBBBBB']);
    const got = await new ReferenceService(pool as never, sequence('TKT-BBBBBB', 'TKT-CCCCCC')).reserve('TKT-AAAAAA');
    expect(got).toBe('TKT-CCCCCC');
    expect(pool.tried).toEqual(['TKT-AAAAAA', 'TKT-BBBBBB', 'TKT-CCCCCC']);
    expect(pool.table.has('TKT-CCCCCC')).toBe(true);
  });

  it('the generator forced to repeat the same reference: 4 collisions then a different one still works (5th try)', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const pool = fakePool(['TKT-AAAAAA']);
    const got = await new ReferenceService(pool as never, sequence('TKT-AAAAAA', 'TKT-AAAAAA', 'TKT-AAAAAA', 'TKT-DDDDDD')).reserve('TKT-AAAAAA');
    expect(got).toBe('TKT-DDDDDD');
    expect(pool.tried).toHaveLength(5);
  });

  it('5 collisions in a row: ReferenceUnavailableError and a loud ERROR line', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const errors: string[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => void errors.push(String(m)));
    const pool = fakePool(['TKT-AAAAAA']);
    await expect(new ReferenceService(pool as never, sequence('TKT-AAAAAA')).reserve('TKT-AAAAAA')).rejects.toBeInstanceOf(ReferenceUnavailableError);
    expect(pool.tried).toHaveLength(MAX_RESERVE_TRIES);
    expect(errors.join()).toContain('COULD NOT RESERVE');
  });

  it('a database error is ReferenceUnavailableError, logged with a code only (never the message)', async () => {
    const errors: string[] = [];
    vi.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown) => void errors.push(String(m)));
    const pool = { query: async () => { throw Object.assign(new Error('connect to postgres://u:SECRETPW@db'), { code: 'ECONNREFUSED' }); } };
    await expect(new ReferenceService(pool as never, sequence('TKT-AAAAAA')).reserve()).rejects.toBeInstanceOf(ReferenceUnavailableError);
    expect(errors.join()).toContain('ECONNREFUSED');
    expect(errors.join()).not.toContain('SECRETPW');
  });

  it('uses INSERT ... ON CONFLICT DO NOTHING RETURNING (never a read-then-write)', async () => {
    let sql = '';
    const pool = { query: async (text: string) => ((sql = text), { rows: [{}], rowCount: 1 }) };
    await new ReferenceService(pool as never, () => 'TKT-AAAAAA').reserve();
    expect(sql).toMatch(/INSERT INTO ticket_references .*ON CONFLICT .*DO NOTHING RETURNING/);
  });
});
