import { createHash, randomBytes } from 'node:crypto';

/** A new session token: 32 random bytes in base64url (43 characters). This is what the cookie holds. */
export const generateSessionToken = (): string => randomBytes(32).toString('base64url');

/**
 * The SHA-256 of a token, as 64 hex characters. Redis stores sessions under this, never under the
 * token, so a copy of Redis holds nothing that can be used as a cookie.
 */
export const hashSessionToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** True for something that could be a token we issued. Anything else is never looked up. */
export const looksLikeSessionToken = (value: unknown): value is string =>
  typeof value === 'string' && TOKEN_SHAPE.test(value);
