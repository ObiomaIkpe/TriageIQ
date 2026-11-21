import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checksumOf, loadMigrations, MigrationError } from './migrate.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'migrations-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const write = (name: string, sql = 'SELECT 1;') => writeFile(path.join(dir, name), sql);

describe('loadMigrations', () => {
  it('reads numbered .sql files in numeric order, with a SHA-256 checksum of each', async () => {
    await write('010_later.sql', 'SELECT 10;');
    await write('002_second.sql', 'SELECT 2;');
    await write('001_first.sql', 'SELECT 1;');

    const files = await loadMigrations(dir);

    expect(files.map((f) => f.name)).toEqual(['001_first.sql', '002_second.sql', '010_later.sql']);
    expect(files.map((f) => f.version)).toEqual([1, 2, 10]);
    expect(files[0].checksum).toBe(checksumOf('SELECT 1;'));
    expect(files[0].checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a one-byte change gives a different checksum', async () => {
    expect(checksumOf('SELECT 1;')).not.toBe(checksumOf('SELECT 1; '));
  });

  it('an empty folder is fine', async () => {
    expect(await loadMigrations(dir)).toEqual([]);
  });

  it.each(['notes.txt', '1_short.sql', 'abc_first.sql', '001-first.sql', '001_First.sql', '001_x.sql.bak'])(
    'refuses a file that is not named like a migration (%s)',
    async (name) => {
      await write(name);
      await expect(loadMigrations(dir)).rejects.toThrow(MigrationError);
    },
  );

  it('refuses two files with the same number', async () => {
    await write('001_a.sql');
    await write('001_b.sql');
    await expect(loadMigrations(dir)).rejects.toThrow('share the number 1');
  });

  it('ignores hidden files', async () => {
    await write('.gitkeep', '');
    await write('001_a.sql');
    expect((await loadMigrations(dir)).map((f) => f.name)).toEqual(['001_a.sql']);
  });

  it("the repository's real migrations folder loads, and starts with the users table", async () => {
    const real = await loadMigrations(new URL('../../migrations', import.meta.url).pathname);
    expect(real[0].name).toBe('001_create_users.sql');
    expect(real[0].sql).toContain('CREATE TABLE users');
    expect(real[0].sql).toContain("CHECK (email = lower(email))");
    expect(real[0].sql).toContain("CHECK (role IN ('reviewer'))");
    expect(real[0].sql).toMatch(/BETWEEN 1 AND 100/);
  });
});
