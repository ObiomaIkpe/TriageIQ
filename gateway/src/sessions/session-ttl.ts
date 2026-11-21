import { SLIDE_INTERVAL_MS } from './session.constants.js';

export interface Lifetimes {
  idleSeconds: number;
  absoluteSeconds: number;
}

/** Seconds a session has left in its absolute lifetime (negative once it is over). */
export const absoluteRemainingSeconds = (createdAtMs: number, nowMs: number, life: Lifetimes): number =>
  life.absoluteSeconds - (nowMs - createdAtMs) / 1000;

/** True once the absolute lifetime is used up, however recently the session was used. */
export const isPastAbsoluteLifetime = (createdAtMs: number, nowMs: number, life: Lifetimes): boolean =>
  absoluteRemainingSeconds(createdAtMs, nowMs, life) <= 0;

/**
 * The Redis key TTL for a session that is used at `nowMs`: the idle timeout, but never longer than
 * what is left of the absolute lifetime. Whole seconds, rounded up (so a session is never cut short
 * by rounding), and 0 when the session is over.
 */
export function sessionTtlSeconds(createdAtMs: number, nowMs: number, life: Lifetimes): number {
  const remaining = absoluteRemainingSeconds(createdAtMs, nowMs, life);
  if (remaining <= 0) return 0;
  return Math.ceil(Math.min(life.idleSeconds, remaining));
}

/** When the session ends if it is not used again: the earlier of idle expiry and absolute expiry. */
export function expiresAtMs(createdAtMs: number, lastSeenAtMs: number, life: Lifetimes): number {
  return Math.min(lastSeenAtMs + life.idleSeconds * 1000, createdAtMs + life.absoluteSeconds * 1000);
}

/** The idle timeout is slid forward only if the last write to Redis was at least a minute ago. */
export const isSlideDue = (lastSeenAtMs: number, nowMs: number): boolean => nowMs - lastSeenAtMs >= SLIDE_INTERVAL_MS;
