import { Inject, Injectable } from '@nestjs/common';
import { PG_POOL, type DbPool } from '../database/database.constants.js';
import { normalizeEmail } from './normalize.js';
import { DuplicateEmailError, type NewUser, type User, type UserRole, type UserWithHash } from './user.types.js';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  role: UserRole;
  disabled_at: Date | null;
  password_changed_at: Date;
  created_at: Date;
  updated_at: Date;
}

/** Every column except the hash: what every query returns unless login needs the hash. */
const PUBLIC_COLUMNS = 'id, email, display_name, role, disabled_at, password_changed_at, created_at, updated_at';

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    disabledAt: row.disabled_at,
    passwordChangedAt: row.password_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Unique violation (23505) on the email constraint. */
function isDuplicateEmail(error: unknown): boolean {
  const e = error as { code?: string; constraint?: string };
  return e?.code === '23505' && e.constraint === 'users_email_key';
}

/**
 * Reviewer accounts in the gateway's database. Plain parameterized SQL: values are only ever
 * passed as parameters, never put into the query text. Emails are normalized (trimmed, lower
 * case) here too, so a caller cannot bypass the rule.
 */
@Injectable()
export class UsersRepository {
  constructor(@Inject(PG_POOL) private readonly pool: DbPool) {}

  /** The account with this email, including its password hash (for login), or undefined. */
  async findByEmail(email: string): Promise<UserWithHash | undefined> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${PUBLIC_COLUMNS}, password_hash FROM users WHERE email = $1`,
      [normalizeEmail(email)],
    );
    return rows[0] ? { ...toUser(rows[0]), passwordHash: rows[0].password_hash } : undefined;
  }

  /** Creates a reviewer. Throws DuplicateEmailError if the email is taken. */
  async create(user: NewUser): Promise<User> {
    try {
      const { rows } = await this.pool.query<UserRow>(
        `INSERT INTO users (email, display_name, password_hash, role)
         VALUES ($1, $2, $3, 'reviewer') RETURNING ${PUBLIC_COLUMNS}`,
        [normalizeEmail(user.email), user.displayName, user.passwordHash],
      );
      return toUser(rows[0]);
    } catch (error) {
      if (isDuplicateEmail(error)) throw new DuplicateEmailError();
      throw error;
    }
  }

  /** Replaces the password hash and stamps password_changed_at. Undefined if there is no such account. */
  async setPassword(email: string, passwordHash: string): Promise<User | undefined> {
    const { rows } = await this.pool.query<UserRow>(
      `UPDATE users SET password_hash = $2, password_changed_at = now(), updated_at = now()
       WHERE email = $1 RETURNING ${PUBLIC_COLUMNS}`,
      [normalizeEmail(email), passwordHash],
    );
    return rows[0] ? toUser(rows[0]) : undefined;
  }

  /**
   * Disables (sets disabled_at) or enables (clears it) an account. Doing it again changes
   * nothing: `changed` says whether this call changed anything. Undefined if there is no such account.
   */
  async setDisabled(email: string, disabled: boolean): Promise<{ user: User; changed: boolean } | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<UserRow>(
        `SELECT ${PUBLIC_COLUMNS} FROM users WHERE email = $1 FOR UPDATE`,
        [normalizeEmail(email)],
      );
      const current = found.rows[0];
      if (!current) {
        await client.query('ROLLBACK');
        return undefined;
      }
      if ((current.disabled_at !== null) === disabled) {
        await client.query('ROLLBACK');
        return { user: toUser(current), changed: false };
      }
      const { rows } = await client.query<UserRow>(
        `UPDATE users SET disabled_at = ${disabled ? 'now()' : 'NULL'}, updated_at = now()
         WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
        [current.id],
      );
      await client.query('COMMIT');
      return { user: toUser(rows[0]), changed: true };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Every account, oldest first, never with a hash. */
  async list(): Promise<User[]> {
    const { rows } = await this.pool.query<UserRow>(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY created_at, email`);
    return rows.map(toUser);
  }
}
