import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/env.schema.js';
import { SESSION_CLOCK, SESSION_STORE, type Clock } from './session.constants.js';
import type { SessionRecord, SessionStore } from './session.store.js';
import { generateSessionToken, hashSessionToken, looksLikeSessionToken } from './session-token.js';
import {
  expiresAtMs,
  isPastAbsoluteLifetime,
  isSlideDue,
  sessionTtlSeconds,
  type Lifetimes,
} from './session-ttl.js';

export interface IssuedSession {
  token: string;
  hash: string;
  expiresAt: Date;
  /** The cookie's Max-Age: the absolute lifetime. */
  maxAgeSeconds: number;
}

export interface LiveSession {
  hash: string;
  record: SessionRecord;
  expiresAt: Date;
}

/**
 * Session lifecycle on top of a SessionStore: issue, look up (with the idle slide), end. It knows
 * nothing about users or HTTP; SessionAuthenticator adds the per-request user check.
 */
@Injectable()
export class SessionService {
  readonly life: Lifetimes;

  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
    @Inject(SESSION_CLOCK) private readonly clock: Clock,
  ) {
    this.life = {
      idleSeconds: config.get('SESSION_IDLE_MINUTES', { infer: true }) * 60,
      absoluteSeconds: config.get('SESSION_ABSOLUTE_HOURS', { infer: true }) * 3600,
    };
  }

  /** Always a NEW token (so a token an attacker planted before login is never the one that logs in). */
  async create(userId: string): Promise<IssuedSession> {
    const now = this.clock();
    const token = generateSessionToken();
    const hash = hashSessionToken(token);
    const record: SessionRecord = {
      user_id: userId,
      created_at: new Date(now).toISOString(),
      last_seen_at: new Date(now).toISOString(),
    };
    await this.store.create(hash, record, sessionTtlSeconds(now, now, this.life), this.life.absoluteSeconds);
    return {
      token,
      hash,
      expiresAt: new Date(expiresAtMs(now, now, this.life)),
      maxAgeSeconds: this.life.absoluteSeconds,
    };
  }

  /**
   * The live session for a token, or undefined if there is none, it has expired, or it is past its
   * absolute lifetime (it is then deleted). Slides the idle timeout, writing to Redis at most once a minute.
   */
  async find(token: string): Promise<LiveSession | undefined> {
    if (!looksLikeSessionToken(token)) return undefined;
    const hash = hashSessionToken(token);
    const record = await this.store.get(hash);
    if (!record) return undefined;

    const now = this.clock();
    const createdAt = Date.parse(record.created_at);
    const lastSeen = Date.parse(record.last_seen_at);
    if (Number.isNaN(createdAt) || Number.isNaN(lastSeen) || isPastAbsoluteLifetime(createdAt, now, this.life)) {
      await this.store.delete(hash);
      return undefined;
    }

    let seen = lastSeen;
    if (isSlideDue(lastSeen, now)) {
      const slid: SessionRecord = { ...record, last_seen_at: new Date(now).toISOString() };
      if (!(await this.store.touch(hash, slid, sessionTtlSeconds(createdAt, now, this.life)))) return undefined;
      seen = now;
    }
    return { hash, record, expiresAt: new Date(expiresAtMs(createdAt, seen, this.life)) };
  }

  /** Ends the session for a token, if there is one. */
  async destroy(token: string): Promise<boolean> {
    if (!looksLikeSessionToken(token)) return false;
    return this.store.delete(hashSessionToken(token));
  }

  destroyByHash(hash: string): Promise<boolean> {
    return this.store.delete(hash);
  }

  revokeAllForUser(userId: string): Promise<number> {
    return this.store.revokeAllForUser(userId);
  }
}
