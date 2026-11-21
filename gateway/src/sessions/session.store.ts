import { Inject, Injectable } from '@nestjs/common';
import { IDEMPOTENCY_REDIS, type KeyValueClient } from '../idempotency/idempotency.constants.js';
import { waitUntilReady } from '../idempotency/redis-ready.js';
import { TriageQueueService } from '../queue/triage-queue.service.js';
import { SESSION_KEY_PREFIX, USER_SESSIONS_KEY_PREFIX } from './session.constants.js';

/** What a session holds in Redis. No email, no password, no token. */
export interface SessionRecord {
  user_id: string;
  created_at: string; // ISO time
  last_seen_at: string; // ISO time
}

/** Where sessions live. Redis in production; tests use an in-memory one. */
export interface SessionStore {
  create(hash: string, record: SessionRecord, ttlSeconds: number, indexTtlSeconds: number): Promise<void>;
  get(hash: string): Promise<SessionRecord | null>;
  /** Rewrites an EXISTING session with a new TTL. False if it no longer exists. */
  touch(hash: string, record: SessionRecord, ttlSeconds: number): Promise<boolean>;
  delete(hash: string): Promise<boolean>;
  /** Deletes every session of a user. Returns how many sessions were deleted. */
  revokeAllForUser(userId: string): Promise<number>;
}

/** Creates the session and adds it to the user's index in ONE step, so the two never disagree. */
export const CREATE_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('SADD', KEYS[2], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[4])
return 1
`;

/** Rewrites a session only if it still exists (a deleted session must not come back). */
export const TOUCH_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return 1
end
return 0
`;

/** Deletes a session and removes it from its user's index, together. ARGV: hash, index key prefix. */
export const DELETE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if not value then return 0 end
local ok, decoded = pcall(cjson.decode, value)
if ok and type(decoded) == 'table' and decoded.user_id then
  redis.call('SREM', ARGV[2] .. decoded.user_id, ARGV[1])
end
return redis.call('DEL', KEYS[1])
`;

/** Deletes every session in a user's index, and the index. ARGV: session key prefix. Returns the count. */
export const REVOKE_ALL_SCRIPT = `
local hashes = redis.call('SMEMBERS', KEYS[1])
local removed = 0
for _, hash in ipairs(hashes) do
  removed = removed + redis.call('DEL', ARGV[1] .. hash)
end
redis.call('DEL', KEYS[1])
return removed
`;

export const sessionKey = (hash: string) => `${SESSION_KEY_PREFIX}${hash}`;
export const userIndexKey = (userId: string) => `${USER_SESSIONS_KEY_PREFIX}${userId}`;

/** Revokes every session of a user on a bare Redis client (used by the CLI as well as the store). */
export async function revokeUserSessions(redis: Pick<KeyValueClient, 'eval'>, userId: string): Promise<number> {
  const removed = await redis.eval(REVOKE_ALL_SCRIPT, 1, userIndexKey(userId), SESSION_KEY_PREFIX);
  return Number(removed);
}

/**
 * Sessions in Redis, on the same connection and under the same deadline rule as the rest of the
 * gateway's Redis use: with Redis down a call fails within about 2 seconds (the caller answers 503).
 * Every change that touches both a session and a user's index is one Lua script.
 */
@Injectable()
export class RedisSessionStore implements SessionStore {
  constructor(
    @Inject(IDEMPOTENCY_REDIS) private readonly redis: KeyValueClient,
    @Inject(TriageQueueService) private readonly queue: TriageQueueService,
  ) {}

  private run<T>(call: () => Promise<T>): Promise<T> {
    return this.queue.guarded(async (expired) => {
      await waitUntilReady(this.redis, expired);
      if (expired()) throw new Error('deadline passed before the call was sent');
      return call();
    });
  }

  async create(hash: string, record: SessionRecord, ttlSeconds: number, indexTtlSeconds: number): Promise<void> {
    await this.run(() =>
      this.redis.eval(
        CREATE_SCRIPT,
        2,
        sessionKey(hash),
        userIndexKey(record.user_id),
        JSON.stringify(record),
        String(ttlSeconds),
        hash,
        String(indexTtlSeconds),
      ),
    );
  }

  async get(hash: string): Promise<SessionRecord | null> {
    const raw = await this.run(() => this.redis.get(sessionKey(hash)));
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw) as Partial<SessionRecord>;
      if (typeof value.user_id === 'string' && typeof value.created_at === 'string' && typeof value.last_seen_at === 'string') {
        return value as SessionRecord;
      }
    } catch {
      // fall through: an unreadable record is no session
    }
    return null;
  }

  async touch(hash: string, record: SessionRecord, ttlSeconds: number): Promise<boolean> {
    const done = await this.run(() =>
      this.redis.eval(TOUCH_SCRIPT, 1, sessionKey(hash), JSON.stringify(record), String(ttlSeconds)),
    );
    return Number(done) === 1;
  }

  async delete(hash: string): Promise<boolean> {
    const removed = await this.run(() =>
      this.redis.eval(DELETE_SCRIPT, 1, sessionKey(hash), hash, USER_SESSIONS_KEY_PREFIX),
    );
    return Number(removed) > 0;
  }

  revokeAllForUser(userId: string): Promise<number> {
    return this.run(() => revokeUserSessions(this.redis, userId));
  }
}
