export const ROLES = ['submitter', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];

/** One entry of the GATEWAY_CLIENTS registry. The key itself is never stored, only its hash. */
export interface RegisteredClient {
  name: string;
  role: Role;
  key_sha256: string;
}
