import { z } from 'zod';

export const EMAIL_MAX = 254;
export const DISPLAY_NAME_MAX = 100;

/** How emails are stored: trimmed and lower case. Used before every lookup and insert. */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const emailSchema = z.email().max(EMAIL_MAX);

/** The normalized email if it looks like an address, otherwise undefined. */
export function parseEmail(raw: string): string | undefined {
  const email = normalizeEmail(raw);
  return emailSchema.safeParse(email).success ? email : undefined;
}

/** The trimmed name if it is 1 to 100 characters, otherwise undefined. */
export function parseDisplayName(raw: string): string | undefined {
  const name = raw.trim();
  const length = Array.from(name).length; // characters, as Postgres char_length counts them
  return length >= 1 && length <= DISPLAY_NAME_MAX ? name : undefined;
}
