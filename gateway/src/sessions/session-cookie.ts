import { parseCookie, stringifySetCookie } from 'cookie';
import { SESSION_COOKIE_NAME } from './session.constants.js';

/** The attributes the session cookie always has. Only Secure and Max-Age vary. */
const BASE = {
  name: SESSION_COOKIE_NAME,
  httpOnly: true,
  sameSite: 'strict' as const,
  path: '/',
};

/** The Set-Cookie value that starts a session. Max-Age is the absolute lifetime. */
export function sessionCookie(token: string, options: { secure: boolean; maxAgeSeconds: number }): string {
  return stringifySetCookie({ ...BASE, value: token, secure: options.secure, maxAge: options.maxAgeSeconds });
}

/** The Set-Cookie value that removes the cookie: same name, path and attributes, already expired. */
export function clearedSessionCookie(options: { secure: boolean }): string {
  return stringifySetCookie({
    ...BASE,
    value: '',
    secure: options.secure,
    maxAge: 0,
    expires: new Date(0),
  });
}

/** The session token from a Cookie request header, if there is one. */
export function readSessionToken(cookieHeader: string | undefined): string | undefined {
  if (typeof cookieHeader !== 'string' || cookieHeader === '') return undefined;
  const value = parseCookie(cookieHeader)[SESSION_COOKIE_NAME];
  return value === undefined || value === '' ? undefined : value;
}
