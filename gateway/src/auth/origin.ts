import type { Request } from 'express';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** GET, HEAD and OPTIONS change nothing, so they need no Origin check. */
export const isSafeMethod = (method: string): boolean => SAFE_METHODS.has(method.toUpperCase());

/**
 * True when the request's Origin header exactly equals one of the allowed origins. A missing Origin,
 * the literal "null", a different scheme, host or port, a trailing slash, a different case: all false.
 * This is a second line of defence behind SameSite=Strict, for requests that carry a session cookie.
 */
export function originAllowed(request: Pick<Request, 'headers'>, allowed: readonly string[]): boolean {
  const origin = request.headers.origin;
  return typeof origin === 'string' && allowed.includes(origin);
}
