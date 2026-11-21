/**
 * Argon2id parameters: the OWASP minimum profile (19 MiB of memory, 2 passes, 1 lane).
 * One place to change them. A hash made with other parameters still verifies, and
 * PasswordHasher.needsRehash() reports it so it can be replaced at the next login.
 */
export const ARGON2_MEMORY_KIB = 19_456;
export const ARGON2_TIME_COST = 2;
export const ARGON2_PARALLELISM = 1;

/** argon2id in @node-rs/argon2's numeric Algorithm enum (a const enum, unusable with isolatedModules). */
export const ARGON2ID = 2;

/** Password length limits, counted in characters after NFC normalization. */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/**
 * A real Argon2id hash, made with the parameters above, of a random password that was thrown
 * away. Login (M4.1b) verifies a submitted password against it when the email is unknown, so
 * unknown and known emails cost the same time. A test fails if the parameters above change
 * without this value being regenerated.
 */
export const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$+94gJXLNh2FHxTmzKUpi9Q$q3lyBvvU9tPnNAFYzgKr6luwvLlkjv1k1eVUTMFJj7Y';
