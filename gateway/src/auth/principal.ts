import type { Role } from './auth.types.js';

/**
 * Who is calling: a machine client (API key) or a logged-in reviewer (session cookie).
 *  - `id` is namespaced ("client:<name>" / "user:<uuid>") and is what rate limits, idempotency keys
 *    and logs use, so a user and a client can never share a bucket.
 *  - `ownerId` is what is stored on a job as its owner. For a client it is the bare client name,
 *    exactly what every existing job already holds (no migration); for a user it is "user:<uuid>".
 *    A bare name can never look like a user's value, because client names cannot contain ":".
 */
export interface ClientPrincipal {
  kind: 'client';
  id: string;
  ownerId: string;
  /** For log lines: the client's name. */
  label: string;
  name: string;
  role: Role;
}

export interface UserPrincipal {
  kind: 'user';
  id: string;
  ownerId: string;
  /** For log lines: "user:<uuid>". Never the email. */
  label: string;
  userId: string;
  email: string;
  displayName: string;
  role: 'reviewer';
  /** The session this request used (its token hash). Never the token. */
  sessionHash: string;
  expiresAt: Date;
}

export type Principal = ClientPrincipal | UserPrincipal;

export function clientPrincipal(name: string, role: Role): ClientPrincipal {
  return { kind: 'client', id: `client:${name}`, ownerId: name, label: name, name, role };
}

export function userPrincipal(
  user: { id: string; email: string; displayName: string },
  session: { hash: string; expiresAt: Date },
): UserPrincipal {
  return {
    kind: 'user',
    id: `user:${user.id}`,
    ownerId: `user:${user.id}`,
    label: `user:${user.id}`,
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    role: 'reviewer',
    sessionHash: session.hash,
    expiresAt: session.expiresAt,
  };
}
