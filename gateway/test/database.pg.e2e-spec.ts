import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate, MIGRATION_LOCK_KEY, DEFAULT_MIGRATIONS_DIR, MigrationError } from '../src/database/migrate.js';
import { createPool } from '../src/database/pool.js';
import { runReviewers, type CliDeps } from '../src/scripts/reviewers.js';
import { ReadyService } from '../src/health/ready.service.js';
import { PasswordHasher } from '../src/users/password-hasher.js';
import { DuplicateEmailError } from '../src/users/user.types.js';
import { UsersRepository } from '../src/users/users.repository.js';

/**
 * The gateway database against a REAL Postgres: migrations, the users table, the repository and the
 * reviewer CLI. Skipped unless GATEWAY_TEST_DATABASE_URL is set, and it refuses any database whose
 * name does not end in "_test" because it DROPS the public schema before each test. Example:
 *   docker run --rm -d --name gw-pg-test -e POSTGRES_PASSWORD=x -p 127.0.0.1:5441:5432 postgres:16-alpine
 *   docker exec gw-pg-test createdb -U postgres gateway_test
 *   GATEWAY_TEST_DATABASE_URL=postgresql://postgres:x@127.0.0.1:5441/gateway_test npm run test:e2e
 */
const URL_ = process.env.GATEWAY_TEST_DATABASE_URL;
const GOOD = 'a long and unusual passphrase';

if (URL_ && !/\/[^/?]*_test(\?.*)?$/.test(URL_)) {
  throw new Error('GATEWAY_TEST_DATABASE_URL must name a database whose name ends in _test');
}

describe.skipIf(!URL_)('gateway database (real Postgres)', () => {
  let pool: pg.Pool;
  let dir: string;
  const hasher = new PasswordHasher();

  beforeAll(() => {
    pool = createPool(URL_ as string, { statementTimeoutMs: 0, max: 6 });
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await pool.query('DROP SCHEMA public CASCADE');
    await pool.query('CREATE SCHEMA public');
    dir = await mkdtemp(path.join(tmpdir(), 'pg-migrations-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = (name: string, sql: string) => writeFile(path.join(dir, name), sql);
  const tables = async () =>
    (await pool.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).rows.map((r) => r.t);
  const recorded = async () =>
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name')).rows.map((r) => r.name);

  describe('the migration runner', () => {
    it("applies the repository's migrations to an empty database and records them", async () => {
      const result = await migrate(pool, DEFAULT_MIGRATIONS_DIR);
      expect(result.applied).toEqual(['001_create_users.sql']);
      expect(await tables()).toEqual(['schema_migrations', 'users']);
      expect(await recorded()).toEqual(['001_create_users.sql']);
      const { rows } = await pool.query<{ checksum: string }>('SELECT checksum FROM schema_migrations');
      expect(rows[0].checksum).toMatch(/^[0-9a-f]{64}$/);
    });

    it('running it again applies nothing and changes nothing', async () => {
      await migrate(pool, DEFAULT_MIGRATIONS_DIR);
      const before = await pool.query('SELECT name, checksum, applied_at FROM schema_migrations');
      const again = await migrate(pool, DEFAULT_MIGRATIONS_DIR);
      expect(again).toEqual({ applied: [], alreadyApplied: ['001_create_users.sql'] });
      expect((await pool.query('SELECT name, checksum, applied_at FROM schema_migrations')).rows).toEqual(before.rows);
    });

    it('applies only the new files when one is added later', async () => {
      await write('001_a.sql', 'CREATE TABLE a (x int);');
      await migrate(pool, dir);
      await write('002_b.sql', 'CREATE TABLE b (x int);');
      const result = await migrate(pool, dir);
      expect(result).toEqual({ applied: ['002_b.sql'], alreadyApplied: ['001_a.sql'] });
      expect(await tables()).toEqual(['a', 'b', 'schema_migrations']);
    });

    it('refuses to run if an already-applied file was changed, and applies nothing else', async () => {
      await write('001_a.sql', 'CREATE TABLE a (x int);');
      await migrate(pool, dir);
      await write('001_a.sql', 'CREATE TABLE a (x int, y int);'); // edited after being applied
      await write('002_b.sql', 'CREATE TABLE b (x int);');

      await expect(migrate(pool, dir)).rejects.toThrow(/001_a\.sql was changed after it was applied/);
      expect(await tables()).toEqual(['a', 'schema_migrations']); // 002 did NOT run
      expect(await recorded()).toEqual(['001_a.sql']);
    });

    it('refuses to run if an applied file has vanished', async () => {
      await write('001_a.sql', 'CREATE TABLE a (x int);');
      await migrate(pool, dir);
      await unlink(path.join(dir, '001_a.sql'));
      await expect(migrate(pool, dir)).rejects.toThrow(/001_a\.sql was applied but its file is missing/);
    });

    it('refuses a new file numbered below one already applied', async () => {
      await write('002_b.sql', 'CREATE TABLE b (x int);');
      await migrate(pool, dir);
      await write('001_a.sql', 'CREATE TABLE a (x int);');
      await expect(migrate(pool, dir)).rejects.toThrow(/001_a\.sql is numbered below/);
      expect(await tables()).toEqual(['b', 'schema_migrations']);
    });

    it('a failing file is rolled back completely and not recorded; earlier files stay applied', async () => {
      await write('001_ok.sql', 'CREATE TABLE ok_table (x int);');
      await write('002_bad.sql', 'CREATE TABLE half_done (x int); SELECT 1/0;');
      await write('003_never.sql', 'CREATE TABLE never_runs (x int);');

      await expect(migrate(pool, dir)).rejects.toThrow(/002_bad\.sql failed and was rolled back \(22012/);
      expect(await tables()).toEqual(['ok_table', 'schema_migrations']); // no half_done, no never_runs
      expect(await recorded()).toEqual(['001_ok.sql']);
    });

    it('MigrationError is the type thrown, so a caller can tell it from a connection problem', async () => {
      await write('001_bad.sql', 'SELECT nope FROM nowhere;');
      await expect(migrate(pool, dir)).rejects.toBeInstanceOf(MigrationError);
    });

    it('holds a Postgres advisory lock while it runs, and releases it after', async () => {
      await write('001_slow.sql', 'SELECT pg_sleep(1);');
      const running = migrate(pool, dir);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const during = await pool.query<{ got: boolean }>('SELECT pg_try_advisory_lock($1) AS got', [MIGRATION_LOCK_KEY]);
      expect(during.rows[0].got).toBe(false); // the runner holds it
      await running;
      const after = await pool.query<{ got: boolean }>('SELECT pg_try_advisory_lock($1) AS got', [MIGRATION_LOCK_KEY]);
      expect(after.rows[0].got).toBe(true); // free again (and now held by this session)
      await pool.query('SELECT pg_advisory_unlock_all()');
    });

    it('two runners at the same moment cannot race: the file is applied exactly once and neither fails', async () => {
      await write('001_slow.sql', 'CREATE TABLE slow_table (x int); SELECT pg_sleep(1);');
      const [a, b] = await Promise.all([migrate(pool, dir), migrate(pool, dir)]);
      expect([...a.applied, ...b.applied]).toEqual(['001_slow.sql']);
      expect(await recorded()).toEqual(['001_slow.sql']);
      expect(await tables()).toContain('slow_table');
    });

    it('five runners at once: still exactly one application', async () => {
      await write('001_a.sql', 'CREATE TABLE a (x int);');
      await write('002_b.sql', 'CREATE TABLE b (x int); SELECT pg_sleep(0.3);');
      const results = await Promise.all(Array.from({ length: 5 }, () => migrate(pool, dir)));
      expect(results.flatMap((r) => r.applied).sort((x, y) => x.localeCompare(y))).toEqual(['001_a.sql', '002_b.sql']);
    });
  });

  describe('the users table (migration 001)', () => {
    beforeEach(async () => {
      await migrate(pool, DEFAULT_MIGRATIONS_DIR);
    });
    const insert = (over: Partial<Record<'email' | 'name' | 'role', string>> = {}) =>
      pool.query(
        "INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, '$argon2id$x', $3) RETURNING *",
        [over.email ?? 'ada@example.com', over.name ?? 'Ada', over.role ?? 'reviewer'],
      );

    it('has the documented columns, defaults and nullability', async () => {
      const { rows } = await pool.query<{ column_name: string; is_nullable: string; data_type: string; column_default: string | null }>(
        "SELECT column_name, is_nullable, data_type, column_default FROM information_schema.columns WHERE table_name = 'users' ORDER BY ordinal_position",
      );
      const by = Object.fromEntries(rows.map((r) => [r.column_name, r]));
      expect(Object.keys(by)).toEqual(['id', 'email', 'display_name', 'password_hash', 'role', 'disabled_at', 'password_changed_at', 'created_at', 'updated_at']);
      expect(by.id.data_type).toBe('uuid');
      expect(by.id.column_default).toContain('gen_random_uuid()');
      expect(by.disabled_at.is_nullable).toBe('YES');
      for (const name of ['email', 'display_name', 'password_hash', 'role', 'password_changed_at', 'created_at', 'updated_at']) {
        expect(by[name].is_nullable).toBe('NO');
      }
      for (const name of ['password_changed_at', 'created_at', 'updated_at']) expect(by[name].column_default).toBe('now()');
    });

    it('a row gets a uuid id, timestamps and a NULL disabled_at by default', async () => {
      const { rows } = await insert();
      expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
      expect(rows[0].disabled_at).toBeNull();
      expect(rows[0].created_at).toBeInstanceOf(Date);
      expect(rows[0].password_changed_at).toBeInstanceOf(Date);
    });

    it('the database itself refuses an email that is not lower case', async () => {
      await expect(insert({ email: 'Ada@Example.com' })).rejects.toMatchObject({ code: '23514', constraint: 'users_email_lowercase' });
    });

    it('the email is unique', async () => {
      await insert();
      await expect(insert()).rejects.toMatchObject({ code: '23505', constraint: 'users_email_key' });
    });

    it.each([['admin'], [''], ['Reviewer']])('the role must be "reviewer" (not %j)', async (role) => {
      await expect(insert({ role })).rejects.toMatchObject({ code: '23514', constraint: 'users_role_check' });
    });

    it('display_name must be 1 to 100 characters', async () => {
      await expect(insert({ name: '' })).rejects.toMatchObject({ constraint: 'users_display_name_length' });
      await expect(insert({ name: 'x'.repeat(101) })).rejects.toMatchObject({ constraint: 'users_display_name_length' });
      await expect(insert({ email: 'a@x.co', name: 'x'.repeat(100) })).resolves.toBeDefined();
      await expect(insert({ email: 'b@x.co', name: '😀'.repeat(100) })).resolves.toBeDefined();
    });

    it('nulls are refused where the column is NOT NULL', async () => {
      await expect(pool.query("INSERT INTO users (email, display_name, role) VALUES ('a@b.co', 'A', 'reviewer')")).rejects.toMatchObject({ code: '23502' });
    });
  });

  describe('UsersRepository on real rows', () => {
    let repo: UsersRepository;
    beforeEach(async () => {
      await migrate(pool, DEFAULT_MIGRATIONS_DIR);
      repo = new UsersRepository(pool);
    });

    it('create, then findByEmail (with the hash) in any capitalisation', async () => {
      const hash = await hasher.hash(GOOD);
      const created = await repo.create({ email: 'Ada@Example.com', displayName: 'Ada', passwordHash: hash });
      expect(created.email).toBe('ada@example.com');
      expect(created).not.toHaveProperty('passwordHash');

      const found = await repo.findByEmail('  ADA@example.COM ');
      expect(found?.id).toBe(created.id);
      expect(found?.passwordHash).toBe(hash);
      expect(await hasher.verify(found?.passwordHash as string, GOOD)).toBe(true);
      expect(await repo.findByEmail('nobody@example.com')).toBeUndefined();
    });

    it('a duplicate email in ANY capitalisation is a DuplicateEmailError', async () => {
      await repo.create({ email: 'ada@example.com', displayName: 'Ada', passwordHash: 'h' });
      await expect(repo.create({ email: 'ADA@Example.com', displayName: 'Again', passwordHash: 'h' })).rejects.toBeInstanceOf(DuplicateEmailError);
      expect(await repo.list()).toHaveLength(1);
    });

    it('SQL metacharacters in values are just data', async () => {
      const email = "o'brien--;drop@example.com";
      await repo.create({ email, displayName: "Robert'); DROP TABLE users;--", passwordHash: 'h' });
      expect((await repo.findByEmail(email))?.displayName).toBe("Robert'); DROP TABLE users;--");
      expect(await repo.list()).toHaveLength(1); // the table is still there
    });

    it('setPassword replaces the hash and moves password_changed_at forward', async () => {
      const created = await repo.create({ email: 'a@b.co', displayName: 'A', passwordHash: 'old' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      const updated = await repo.setPassword('A@B.co', 'new');
      expect(updated?.passwordChangedAt.getTime()).toBeGreaterThan(created.passwordChangedAt.getTime());
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
      expect((await repo.findByEmail('a@b.co'))?.passwordHash).toBe('new');
      expect(await repo.setPassword('who@b.co', 'x')).toBeUndefined();
    });

    it('setDisabled disables, is idempotent, and enables again; created_at never moves', async () => {
      const created = await repo.create({ email: 'a@b.co', displayName: 'A', passwordHash: 'h' });
      const first = await repo.setDisabled('a@b.co', true);
      expect(first?.changed).toBe(true);
      expect(first?.user.disabledAt).toBeInstanceOf(Date);

      const second = await repo.setDisabled('a@b.co', true);
      expect(second?.changed).toBe(false);
      expect(second?.user.disabledAt?.getTime()).toBe(first?.user.disabledAt?.getTime()); // not re-stamped

      const enabled = await repo.setDisabled('a@b.co', false);
      expect(enabled?.changed).toBe(true);
      expect(enabled?.user.disabledAt).toBeNull();
      expect((await repo.setDisabled('a@b.co', false))?.changed).toBe(false);
      expect(enabled?.user.createdAt.getTime()).toBe(created.createdAt.getTime());
      expect(await repo.setDisabled('who@b.co', true)).toBeUndefined();
    });

    it('disabling does not change the password or password_changed_at', async () => {
      const created = await repo.create({ email: 'a@b.co', displayName: 'A', passwordHash: 'h' });
      await repo.setDisabled('a@b.co', true);
      const after = await repo.findByEmail('a@b.co');
      expect(after?.passwordHash).toBe('h');
      expect(after?.passwordChangedAt.getTime()).toBe(created.passwordChangedAt.getTime());
    });

    it('two simultaneous disables: exactly one reports a change', async () => {
      await repo.create({ email: 'a@b.co', displayName: 'A', passwordHash: 'h' });
      const results = await Promise.all([repo.setDisabled('a@b.co', true), repo.setDisabled('a@b.co', true)]);
      expect(results.filter((r) => r?.changed).length).toBe(1);
    });

    it('list returns everyone oldest first and never a hash', async () => {
      await repo.create({ email: 'first@b.co', displayName: 'First', passwordHash: 'h1' });
      await repo.create({ email: 'second@b.co', displayName: 'Second', passwordHash: 'h2' });
      const users = await repo.list();
      expect(users.map((u) => u.email)).toEqual(['first@b.co', 'second@b.co']);
      for (const user of users) expect(user).not.toHaveProperty('passwordHash');
    });
  });

  describe('/ready check against real Postgres connections', () => {
    const ready = (db: pg.Pool) =>
      new ReadyService(
        { ping: async () => 'PONG' },
        { get: () => 'http://triage.internal:8000' } as never,
        (async () => new Response(null, { status: 200 })) as unknown as typeof fetch,
        1500,
        db,
      );

    it('a reachable database -> postgres ok', async () => {
      const report = await ready(pool).check();
      expect(report.body.checks.postgres).toBe('ok');
      expect(report.ready).toBe(true);
    });

    it('a wrong password -> down with the fixed reason "authentication failed" (no user, URL or message)', async () => {
      const bad = createPool((URL_ as string).replace(/\/\/[^:]+:[^@]+@/, '//nobody:WRONGSECRET@'));
      bad.on('error', () => undefined);
      const report = await ready(bad).check();
      await bad.end();
      expect(report.body.checks.postgres).toBe('down');
      expect(report.body.reasons?.postgres).toBe('authentication failed');
      expect(JSON.stringify(report.body)).not.toMatch(/WRONGSECRET|nobody|127\.0\.0\.1/);
    });

    it('nothing listening -> down with "connection refused"', async () => {
      const closed = createPool('postgresql://x:y@127.0.0.1:1/db');
      closed.on('error', () => undefined);
      const report = await ready(closed).check();
      await closed.end();
      expect(report.body.reasons?.postgres).toBe('connection refused');
    });
  });

  describe('the reviewer CLI against the real database', () => {
    let out: string[];
    let err: string[];
    let deps: CliDeps;
    let passwords: string[];
    beforeEach(async () => {
      await migrate(pool, DEFAULT_MIGRATIONS_DIR);
      out = [];
      err = [];
      passwords = [];
      deps = {
        users: new UsersRepository(pool),
        hasher,
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
        askPassword: async () => passwords.shift() ?? GOOD,
        interactive: false,
      };
    });
    const cli = (...argv: string[]) => runReviewers(argv, deps);

    it('create -> list -> set-password -> disable -> enable, end to end, and the stored hash is Argon2id', async () => {
      expect(await cli('create', '--email', 'Ada@Example.com', '--name', 'Ada Lovelace')).toBe(0);
      const stored = await new UsersRepository(pool).findByEmail('ada@example.com');
      expect(stored?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(await hasher.verify(stored?.passwordHash as string, GOOD)).toBe(true);

      out.length = 0;
      expect(await cli('list')).toBe(0);
      expect(out.join('\n')).toMatch(/ada@example\.com\s+Ada Lovelace\s+reviewer\s+no\s+\d{4}-/);

      const newPassword = 'a completely different passphrase';
      passwords.push(newPassword);
      expect(await cli('set-password', '--email', 'ada@example.com')).toBe(0);
      const changed = await new UsersRepository(pool).findByEmail('ada@example.com');
      expect(await hasher.verify(changed?.passwordHash as string, newPassword)).toBe(true);
      expect(await hasher.verify(changed?.passwordHash as string, GOOD)).toBe(false);
      expect(changed?.passwordChangedAt.getTime()).toBeGreaterThan(stored?.passwordChangedAt.getTime() as number);

      expect(await cli('disable', '--email', 'ada@example.com')).toBe(0);
      expect(await cli('disable', '--email', 'ada@example.com')).toBe(0);
      expect(out.at(-1)).toBe('ada@example.com is already disabled. Nothing changed.');
      out.length = 0;
      await cli('list');
      expect(out.join('\n')).toMatch(/Ada Lovelace\s+reviewer\s+yes/);
      expect(await cli('enable', '--email', 'ada@example.com')).toBe(0);
    });

    it('a duplicate email and an unknown email are clean errors with exit 1', async () => {
      await cli('create', '--email', 'a@b.co', '--name', 'A');
      expect(await cli('create', '--email', 'A@B.CO', '--name', 'Other')).toBe(1);
      expect(err.at(-1)).toBe('A reviewer with the email a@b.co already exists.');
      expect(await cli('set-password', '--email', 'who@b.co')).toBe(1);
      expect(await cli('disable', '--email', 'who@b.co')).toBe(1);
      expect(await cli('enable', '--email', 'who@b.co')).toBe(1);
      expect(err.at(-1)).toBe('No reviewer with the email who@b.co.');
    });

    it('neither a password nor a hash is ever printed', async () => {
      await cli('create', '--email', 'a@b.co', '--name', 'A');
      await cli('list');
      const everything = [...out, ...err].join('\n');
      expect(everything).not.toContain(GOOD);
      expect(everything).not.toMatch(/argon2/);
    });
  });
});
