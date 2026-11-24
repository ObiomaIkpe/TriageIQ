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
  /** 'demo' only for the shared demo user. */
  role: 'reviewer' | 'demo';
  /** The session this request used (its token hash). Never the token. */
  sessionHash: string;
  expiresAt: Date;
}

export type Principal = ClientPrincipal | UserPrincipal;

export function clientPrincipal(name: string, role: Role): ClientPrincipal {
  return { kind: 'client', id: `client:${name}`, ownerId: name, label: name, name, role };
}

export function userPrincipal(
  user: { id: string; email: string; displayName: string; role?: 'reviewer' | 'demo' },
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
    role: user.role ?? 'reviewer',
    sessionHash: session.hash,
    expiresAt: session.expiresAt,
  };
}

/** Who a review is recorded as, in the body the gateway sends to Python. */
export interface ReviewerIdentity {
  /** "user:<uuid>" or "client:<name>": the principal's namespaced id. */
  id: string;
  /** A user's display name (a snapshot, as Python stores it), or a client's name. */
  name: string;
}

/**
 * The reviewer for a request, taken ONLY from the authenticated principal, never from anything the
 * caller sent. A logged-in user is recorded under their id and the display name loaded with their
 * session; a machine client under its namespaced name.
 */
export function reviewerFor(principal: Principal): ReviewerIdentity {
  return principal.kind === 'user'
    ? { id: principal.id, name: principal.displayName }
    : { id: principal.id, name: principal.name };
}

/**
 * Which side of the real/demo wall a principal is on, sent to the Python service with every ticket read and review. It comes ONLY
 * from the authenticated principal: the demo user (a session) is "demo"; every other principal, users and API clients alike, is "real".
 */
export type TicketScope = 'real' | 'demo';
export const scopeFor = (principal: Principal): TicketScope =>
  principal.kind === 'user' && principal.role === 'demo' ? 'demo' : 'real';
