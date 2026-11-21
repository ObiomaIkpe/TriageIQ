// Only Node's own modules and erasable TypeScript here: scripts/make-client-key.ts imports
// this file directly (Node runs it by stripping the types, with no build step).
import { createHash, randomBytes } from 'node:crypto';

export const KEY_PREFIX = 'tiq_';
export const NAME_PATTERN = /^[a-z0-9-]{1,40}$/;
export const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** A new client key: "tiq_" and 32 random bytes in base64url (43 characters). */
export function generateKey(): string {
  return KEY_PREFIX + randomBytes(32).toString('base64url');
}

/** The SHA-256 of a key, as 64 lowercase hex characters. This is what the registry stores. */
export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** The registry entry for a key, ready to paste into GATEWAY_CLIENTS. */
export function registryEntry(name: string, role: string, key: string) {
  return { name, role, key_sha256: hashKey(key) };
}
