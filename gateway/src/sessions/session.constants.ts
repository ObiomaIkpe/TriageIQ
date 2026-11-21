/** Injection tokens. */
export const SESSION_STORE = Symbol('SESSION_STORE');
export const SESSION_CLOCK = Symbol('SESSION_CLOCK');

export const SESSION_COOKIE_NAME = 'tiq_session';
export const SESSION_KEY_PREFIX = 'session:';
export const USER_SESSIONS_KEY_PREFIX = 'user_sessions:';

/** A session is written back to Redis (sliding its idle timeout) at most this often. */
export const SLIDE_INTERVAL_MS = 60_000;

/** The current time in ms. Tests replace it. */
export type Clock = () => number;
