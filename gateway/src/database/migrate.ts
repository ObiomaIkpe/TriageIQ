import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { DbClient, DbPool } from './database.constants.js';
import { createPool } from './pool.js';

/** One advisory-lock key for every runner, so two of them can never migrate at once. */
export const MIGRATION_LOCK_KEY = 7_243_001;

export const DEFAULT_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

const FILE_PATTERN = /^(\d{3,})_[a-z0-9_]+\.sql$/;

export interface MigrationFile {
  name: string;
  version: number;
  sql: string;
  checksum: string;
}

/** A problem that must stop the run: nothing is applied after it. */
export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

export const checksumOf = (sql: string) => createHash('sha256').update(sql, 'utf8').digest('hex');

/** The numbered .sql files in a folder, in order. Anything else in the folder is an error. */
export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((name) => !name.startsWith('.'));
  const files: MigrationFile[] = [];
  for (const name of names) {
    const match = FILE_PATTERN.exec(name);
    if (!match) throw new MigrationError(`"${name}" is not a migration file name (expected 001_name.sql)`);
    const sql = await readFile(path.join(dir, name), 'utf8');
    files.push({ name, version: Number(match[1]), sql, checksum: checksumOf(sql) });
  }
  files.sort((a, b) => a.version - b.version);
  for (let i = 1; i < files.length; i += 1) {
    if (files[i].version === files[i - 1].version) {
      throw new MigrationError(`two migration files share the number ${files[i].version}`);
    }
  }
  return files;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Applies the migrations that have not been applied yet.
 *  - A Postgres advisory lock is held for the whole run, so two runners cannot race.
 *  - Each file runs in its own transaction, together with the row that records it.
 *  - Applied files are recorded with a SHA-256 checksum. If one was edited afterwards, or has
 *    vanished, or a new file is numbered below an applied one, the run refuses and applies nothing.
 */
export async function migrate(
  pool: DbPool,
  dir: string = DEFAULT_MIGRATIONS_DIR,
  log: (line: string) => void = () => undefined,
): Promise<MigrateResult> {
  const files = await loadMigrations(dir);
  const client: DbClient = await pool.connect();
  let broken = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    );
    const applied = new Map(rows.map((row) => [row.name, row.checksum]));
    const onDisk = new Map(files.map((file) => [file.name, file]));

    for (const [name, checksum] of applied) {
      const file = onDisk.get(name);
      if (!file) throw new MigrationError(`migration ${name} was applied but its file is missing`);
      if (file.checksum !== checksum) {
        throw new MigrationError(`migration ${name} was changed after it was applied; add a new migration instead`);
      }
    }
    const newest = Math.max(0, ...[...applied.keys()].map((name) => Number(FILE_PATTERN.exec(name)?.[1] ?? 0)));
    const pending = files.filter((file) => !applied.has(file.name));
    for (const file of pending) {
      if (file.version < newest) {
        throw new MigrationError(`migration ${file.name} is numbered below one that is already applied`);
      }
    }

    const done: string[] = [];
    for (const file of pending) {
      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file.name, file.checksum]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        const code = (error as { code?: string }).code;
        throw new MigrationError(`migration ${file.name} failed and was rolled back (${code ?? 'error'}: ${(error as Error).message})`);
      }
      log(`applied ${file.name}`);
      done.push(file.name);
    }
    return { applied: done, alreadyApplied: files.filter((f) => applied.has(f.name)).map((f) => f.name) };
  } catch (error) {
    broken = true;
    throw error;
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } catch {
      broken = true; // the lock may still be held: drop the connection, which releases it
    }
    client.release(broken);
  }
}

/** The one-shot command: `node dist/database/migrate.js`. Exit code 0 on success, 1 on any failure. */
async function main(): Promise<number> {
  const url = process.env.GATEWAY_DATABASE_URL?.trim();
  if (!url) {
    console.error('GATEWAY_DATABASE_URL is not set.');
    return 1;
  }
  // No statement timeout: a migration may legitimately take long.
  const pool = createPool(url, { statementTimeoutMs: 0, max: 2 });
  pool.on('error', () => undefined);
  try {
    const result = await migrate(pool, DEFAULT_MIGRATIONS_DIR, (line) => console.log(line));
    console.log(
      result.applied.length === 0
        ? `Database is up to date (${result.alreadyApplied.length} migration(s) already applied).`
        : `Applied ${result.applied.length} migration(s).`,
    );
    return 0;
  } catch (error) {
    // The message never contains the connection URL.
    console.error(`Migration failed: ${(error as Error).message}`);
    return 1;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
