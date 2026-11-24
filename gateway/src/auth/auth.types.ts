export const ROLES = ['submitter', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Every role a caller can have. `demo` exists ONLY for the shared demo user (a session, never an API key): it is not in ROLES, so a
 * GATEWAY_CLIENTS entry can never be given it.
 */
export type PrincipalRole = Role | 'demo';

/** One entry of the GATEWAY_CLIENTS registry. The key itself is never stored, only its hash. */
export interface RegisteredClient {
  name: string;
  role: Role;
  key_sha256: string;
}
