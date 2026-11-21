import { timingSafeEqual } from 'node:crypto';
import type { RegisteredClient } from './auth.types.js';
import { hashKey } from './client-key.js';

/** Longest key accepted. Real keys are 47 characters; the cap only stops absurd input. */
const MAX_KEY_LENGTH = 200;
const BEARER = /^bearer +([A-Za-z0-9_-]+)$/i;

/** The key from "Authorization: Bearer <key>", or undefined if the header is missing or malformed. */
export function extractBearerKey(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined;
  const match = BEARER.exec(header.trim());
  if (!match || match[1].length > MAX_KEY_LENGTH) return undefined;
  return match[1];
}

/**
 * The registered client whose key hash equals the SHA-256 of `presentedKey`, or undefined.
 * Every registered hash is compared, with timingSafeEqual, and the loop never stops early, so
 * the time taken does not reveal which entry matched or how much of a hash was right.
 */
export function findClient(
  clients: readonly RegisteredClient[],
  presentedKey: string,
): RegisteredClient | undefined {
  const presented = Buffer.from(hashKey(presentedKey), 'hex');
  let found: RegisteredClient | undefined;
  for (const client of clients) {
    const registered = Buffer.from(client.key_sha256, 'hex');
    if (registered.length === presented.length && timingSafeEqual(registered, presented)) {
      found = client;
    }
  }
  return found;
}
