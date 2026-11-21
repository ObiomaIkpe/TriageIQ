import type { CounterStore } from '../src/auth/login-limiter.js';
import type { SessionRecord, SessionStore } from '../src/sessions/session.store.js';
import type { User, UserWithHash } from '../src/users/user.types.js';

/** A clock a test can move. `fn` is what the app receives as its clock. */
export class FakeClock {
  constructor(public now = Date.parse('2026-11-21T12:00:00.000Z')) {}
  readonly fn = () => this.now;
  advance(ms: number) {
    this.now += ms;
  }
  advanceSeconds(seconds: number) {
    this.advance(seconds * 1000);
  }
}

/** Sessions in memory, with Redis-like TTLs measured by the fake clock. */
export class MemorySessionStore implements SessionStore {
  entries = new Map<string, { record: SessionRecord; expiresAt: number }>();
  index = new Map<string, Set<string>>();
  writes = { create: 0, touch: 0, delete: 0 };

  constructor(private readonly clock: FakeClock) {}

  private live(hash: string) {
    const entry = this.entries.get(hash);
    if (entry && entry.expiresAt <= this.clock.now) {
      this.entries.delete(hash); // Redis would have removed it
      return undefined;
    }
    return entry;
  }

  async create(hash: string, record: SessionRecord, ttlSeconds: number, _indexTtlSeconds?: number) {
    this.writes.create += 1;
    this.entries.set(hash, { record, expiresAt: this.clock.now + ttlSeconds * 1000 });
    const set = this.index.get(record.user_id) ?? new Set<string>();
    set.add(hash);
    this.index.set(record.user_id, set);
  }

  async get(hash: string) {
    return this.live(hash)?.record ?? null;
  }

  async touch(hash: string, record: SessionRecord, ttlSeconds: number) {
    if (!this.live(hash)) return false;
    this.writes.touch += 1;
    this.entries.set(hash, { record, expiresAt: this.clock.now + ttlSeconds * 1000 });
    return true;
  }

  async delete(hash: string) {
    const entry = this.live(hash);
    if (!entry) return false;
    this.writes.delete += 1;
    this.entries.delete(hash);
    this.index.get(entry.record.user_id)?.delete(hash);
    return true;
  }

  async revokeAllForUser(userId: string) {
    let removed = 0;
    for (const hash of this.index.get(userId) ?? []) if (this.entries.delete(hash)) removed += 1;
    this.index.delete(userId);
    return removed;
  }

  /** TTL left on a session, in seconds. */
  ttl(hash: string) {
    const entry = this.live(hash);
    return entry ? Math.round((entry.expiresAt - this.clock.now) / 1000) : undefined;
  }
}

/** Failure counters in memory, with fixed windows measured by the fake clock. */
export class MemoryCounterStore implements CounterStore {
  entries = new Map<string, { count: number; expiresAt: number }>();
  constructor(private readonly clock: FakeClock) {}

  private live(key: string) {
    const entry = this.entries.get(key);
    if (entry && entry.expiresAt <= this.clock.now) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async read(key: string) {
    const entry = this.live(key);
    return entry
      ? { count: entry.count, ttlSeconds: Math.ceil((entry.expiresAt - this.clock.now) / 1000) }
      : { count: 0, ttlSeconds: -2 };
  }

  async increment(key: string, windowSeconds: number) {
    const entry = this.live(key) ?? { count: 0, expiresAt: this.clock.now + windowSeconds * 1000 };
    entry.count += 1;
    this.entries.set(key, entry);
  }

  async remove(key: string) {
    this.entries.delete(key);
  }
}

/** The parts of UsersRepository the login code uses, over a Map. */
export class MemoryUsers {
  rows = new Map<string, UserWithHash>();
  rehashes: { id: string; oldHash: string; newHash: string }[] = [];
  lookups = { byEmail: 0, byId: 0 };
  private nextId = 1;

  constructor(private readonly clock: FakeClock) {}

  add(input: { email: string; passwordHash: string; displayName?: string; disabled?: boolean; passwordChangedAt?: Date }): UserWithHash {
    const now = new Date(this.clock.now);
    const user: UserWithHash = {
      id: `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`,
      email: input.email.toLowerCase(),
      displayName: input.displayName ?? 'Ada Lovelace',
      role: 'reviewer',
      disabledAt: input.disabled ? now : null,
      passwordChangedAt: input.passwordChangedAt ?? new Date(this.clock.now - 60_000),
      createdAt: now,
      updatedAt: now,
      passwordHash: input.passwordHash,
    };
    this.rows.set(user.id, user);
    return user;
  }

  async findByEmail(email: string) {
    this.lookups.byEmail += 1;
    return [...this.rows.values()].find((u) => u.email === email.trim().toLowerCase());
  }

  async findById(id: string): Promise<User | undefined> {
    this.lookups.byId += 1;
    const row = this.rows.get(id);
    if (!row) return undefined;
    const { passwordHash: _hash, ...user } = row;
    return user;
  }

  async rehashPassword(id: string, oldHash: string, newHash: string) {
    const row = this.rows.get(id);
    if (!row || row.passwordHash !== oldHash) return false;
    row.passwordHash = newHash;
    this.rehashes.push({ id, oldHash, newHash });
    return true;
  }

  disable(id: string) {
    const row = this.rows.get(id);
    if (row) row.disabledAt = new Date(this.clock.now);
  }

  changePassword(id: string, passwordHash: string) {
    const row = this.rows.get(id);
    if (row) {
      row.passwordHash = passwordHash;
      row.passwordChangedAt = new Date(this.clock.now);
    }
  }
}
