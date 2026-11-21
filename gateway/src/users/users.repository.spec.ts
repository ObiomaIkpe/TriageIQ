import type { DbPool } from '../database/database.constants.js';
import { UsersRepository } from './users.repository.js';
import { DuplicateEmailError } from './user.types.js';

const NOW = new Date('2026-11-21T12:00:00.000Z');
const row = (over: Record<string, unknown> = {}) => ({
  id: '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34',
  email: 'ada@example.com',
  display_name: 'Ada',
  password_hash: '$argon2id$HASH',
  role: 'reviewer',
  disabled_at: null,
  password_changed_at: NOW,
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

interface Call {
  text: string;
  values?: unknown[];
}

/** A fake pool that records every query and answers from a queue. */
function fakePool(answers: { rows: unknown[]; error?: unknown }[] = []) {
  const calls: Call[] = [];
  const queue = [...answers];
  const run = async (text: string, values?: unknown[]) => {
    calls.push({ text: text.replace(/\s+/g, ' ').trim(), values });
    const next = queue.shift() ?? { rows: [] };
    if (next.error) throw next.error;
    return { rows: next.rows, rowCount: next.rows.length };
  };
  const released: unknown[] = [];
  return {
    calls,
    released,
    pool: {
      query: run,
      connect: async () => ({ query: run, release: (e?: unknown) => void released.push(e ?? 'ok') }),
    } as unknown as DbPool,
  };
}

describe('UsersRepository', () => {
  describe('parameterized SQL only', () => {
    it('values travel as parameters, never inside the query text', async () => {
      const evil = "x'; DROP TABLE users; --@example.com";
      const { pool, calls } = fakePool([{ rows: [] }, { rows: [row()] }, { rows: [] }]);
      const repo = new UsersRepository(pool);

      await repo.findByEmail(evil);
      await repo.create({ email: evil, displayName: "Robert'); DROP TABLE users;--", passwordHash: '$argon2id$x' });
      await repo.setPassword(evil, "'; --");

      for (const call of calls) {
        expect(call.text).not.toContain('DROP');
        expect(call.text).not.toContain("'; --");
        expect(call.text).toMatch(/\$1/);
        expect(call.values?.length).toBeGreaterThan(0);
      }
    });
  });

  describe('findByEmail', () => {
    it('normalizes the email before the query and returns the account WITH its hash', async () => {
      const { pool, calls } = fakePool([{ rows: [row()] }]);
      const user = await new UsersRepository(pool).findByEmail('  ADA@Example.com ');

      expect(calls[0].values).toEqual(['ada@example.com']);
      expect(user).toEqual({
        id: '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34',
        email: 'ada@example.com',
        displayName: 'Ada',
        role: 'reviewer',
        disabledAt: null,
        passwordChangedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
        passwordHash: '$argon2id$HASH',
      });
    });

    it('is undefined when there is no such account', async () => {
      expect(await new UsersRepository(fakePool([{ rows: [] }]).pool).findByEmail('nobody@example.com')).toBeUndefined();
    });
  });

  describe('create', () => {
    it('inserts a reviewer with a normalized email and returns the account without the hash', async () => {
      const { pool, calls } = fakePool([{ rows: [row()] }]);
      const user = await new UsersRepository(pool).create({
        email: ' Ada@Example.com',
        displayName: 'Ada',
        passwordHash: '$argon2id$HASH',
      });

      expect(calls[0].values).toEqual(['ada@example.com', 'Ada', '$argon2id$HASH']);
      expect(calls[0].text).toContain("'reviewer'");
      expect(user).not.toHaveProperty('passwordHash');
      expect(user.email).toBe('ada@example.com');
    });

    it('maps the unique violation on the email constraint to DuplicateEmailError', async () => {
      const unique = Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint: 'users_email_key',
      });
      const repo = new UsersRepository(fakePool([{ rows: [], error: unique }]).pool);
      await expect(repo.create({ email: 'a@b.co', displayName: 'A', passwordHash: 'h' })).rejects.toBeInstanceOf(
        DuplicateEmailError,
      );
    });

    it('any other database error passes through unchanged (not hidden as a duplicate)', async () => {
      const other = Object.assign(new Error('boom'), { code: '23505', constraint: 'some_other_key' });
      const repo = new UsersRepository(fakePool([{ rows: [], error: other }]).pool);
      await expect(repo.create({ email: 'a@b.co', displayName: 'A', passwordHash: 'h' })).rejects.toBe(other);
      const outage = Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
      await expect(
        new UsersRepository(fakePool([{ rows: [], error: outage }]).pool).create({ email: 'a@b.co', displayName: 'A', passwordHash: 'h' }),
      ).rejects.toBe(outage);
    });
  });

  describe('setPassword', () => {
    it('stamps password_changed_at and updated_at and returns the account without the hash', async () => {
      const { pool, calls } = fakePool([{ rows: [row()] }]);
      const user = await new UsersRepository(pool).setPassword('ADA@example.com', '$argon2id$NEW');
      expect(calls[0].text).toContain('password_changed_at = now()');
      expect(calls[0].text).toContain('updated_at = now()');
      expect(calls[0].values).toEqual(['ada@example.com', '$argon2id$NEW']);
      expect(user).not.toHaveProperty('passwordHash');
    });

    it('is undefined for an unknown email', async () => {
      expect(await new UsersRepository(fakePool([{ rows: [] }]).pool).setPassword('x@y.zz', 'h')).toBeUndefined();
    });
  });

  describe('setDisabled', () => {
    // answers: BEGIN, SELECT ... FOR UPDATE, [UPDATE], COMMIT/ROLLBACK
    it('disabling an enabled account updates it and reports changed', async () => {
      const { pool, calls, released } = fakePool([
        { rows: [] },
        { rows: [row()] },
        { rows: [row({ disabled_at: NOW })] },
        { rows: [] },
      ]);
      const result = await new UsersRepository(pool).setDisabled('ada@example.com', true);
      expect(result?.changed).toBe(true);
      expect(result?.user.disabledAt).toEqual(NOW);
      expect(calls.map((c) => c.text.split(' ')[0])).toEqual(['BEGIN', 'SELECT', 'UPDATE', 'COMMIT']);
      expect(calls[1].text).toContain('FOR UPDATE');
      expect(calls[2].text).toContain('disabled_at = now()');
      expect(released).toEqual(['ok']);
    });

    it('enabling a disabled account clears disabled_at', async () => {
      const { pool, calls } = fakePool([{ rows: [] }, { rows: [row({ disabled_at: NOW })] }, { rows: [row()] }, { rows: [] }]);
      const result = await new UsersRepository(pool).setDisabled('ada@example.com', false);
      expect(result?.changed).toBe(true);
      expect(calls[2].text).toContain('disabled_at = NULL');
    });

    it('doing it again changes nothing (idempotent): no UPDATE is sent', async () => {
      const { pool, calls } = fakePool([{ rows: [] }, { rows: [row({ disabled_at: NOW })] }, { rows: [] }]);
      const result = await new UsersRepository(pool).setDisabled('ada@example.com', true);
      expect(result?.changed).toBe(false);
      expect(calls.map((c) => c.text.split(' ')[0])).toEqual(['BEGIN', 'SELECT', 'ROLLBACK']);
    });

    it('unknown email -> undefined, and the transaction is closed', async () => {
      const { pool, calls, released } = fakePool([{ rows: [] }, { rows: [] }, { rows: [] }]);
      expect(await new UsersRepository(pool).setDisabled('no@one.zz', true)).toBeUndefined();
      expect(calls.at(-1)?.text).toBe('ROLLBACK');
      expect(released).toEqual(['ok']);
    });

    it('an error rolls back and still releases the connection', async () => {
      const { pool, calls, released } = fakePool([{ rows: [] }, { rows: [], error: new Error('boom') }, { rows: [] }]);
      await expect(new UsersRepository(pool).setDisabled('ada@example.com', true)).rejects.toThrow('boom');
      expect(calls.at(-1)?.text).toBe('ROLLBACK');
      expect(released).toHaveLength(1);
    });
  });

  describe('list', () => {
    it('returns every account, oldest first, and never selects or returns a hash', async () => {
      const { pool, calls } = fakePool([{ rows: [row(), row({ email: 'b@example.com' })] }]);
      const users = await new UsersRepository(pool).list();
      expect(users.map((u) => u.email)).toEqual(['ada@example.com', 'b@example.com']);
      expect(calls[0].text).toContain('ORDER BY created_at');
      expect(calls[0].text).not.toContain('password_hash');
      for (const user of users) expect(user).not.toHaveProperty('passwordHash');
    });
  });
});
