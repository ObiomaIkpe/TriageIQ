import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password.constants.js';

/** How a password is compared and hashed: Unicode NFC, so "é" typed two ways is one password. */
export const normalizePassword = (password: string) => password.normalize('NFC');

/** Length in characters (code points), after normalization. */
export const passwordLength = (password: string) => Array.from(normalizePassword(password)).length;

/** Very common passwords that are long enough to pass the length rule. Compared case-insensitively. */
export const COMMON_PASSWORDS: readonly string[] = [
  'password1234',
  'password12345',
  'password123456',
  'passwordpassword',
  'qwertyuiop12',
  'qwertyuiopas',
  'qwertyuiop123',
  '123456789012',
  '1234567890123',
  '12345678901234',
  '1q2w3e4r5t6y',
  'letmein123456',
  'iloveyou1234',
  'welcome12345',
  'administrator',
  'admin1234567',
  'changeme1234',
  'abc123abc123',
  'trustno1trust',
  'correcthorsebatterystaple',
];

export type PasswordCheck = { ok: true } | { ok: false; reason: string };

/**
 * The password rules (NIST style: length and a blocklist, no composition rules):
 *  - 12 to 128 characters after NFC normalization (the maximum stops hashing from being used
 *    to burn CPU),
 *  - not the account's email, nor the part of it before the @ (any capitalisation),
 *  - not one of a short list of very common passwords.
 * Pure: it never touches a database or logs anything.
 */
export function validatePassword(password: string, email: string): PasswordCheck {
  const length = passwordLength(password);
  if (length < PASSWORD_MIN_LENGTH) {
    return { ok: false, reason: `The password must be at least ${PASSWORD_MIN_LENGTH} characters long.` };
  }
  if (length > PASSWORD_MAX_LENGTH) {
    return { ok: false, reason: `The password must be at most ${PASSWORD_MAX_LENGTH} characters long.` };
  }
  const candidate = normalizePassword(password).toLowerCase();
  const address = normalizePassword(email).trim().toLowerCase();
  const localPart = address.split('@')[0];
  if (candidate === address || (localPart !== '' && candidate === localPart)) {
    return { ok: false, reason: 'The password must not be the email address or the part of it before the @.' };
  }
  if (COMMON_PASSWORDS.includes(candidate)) {
    return { ok: false, reason: 'That password is too common. Choose a different one.' };
  }
  return { ok: true };
}
