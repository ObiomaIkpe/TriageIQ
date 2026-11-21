import { Injectable } from '@nestjs/common';
import { hash, parseOptions, verify } from '@node-rs/argon2';
import {
  ARGON2ID,
  ARGON2_MEMORY_KIB,
  ARGON2_PARALLELISM,
  ARGON2_TIME_COST,
  DUMMY_PASSWORD_HASH,
  PASSWORD_MAX_LENGTH,
} from './password.constants.js';
import { normalizePassword, passwordLength } from './password-policy.js';

const PARAMS = {
  algorithm: ARGON2ID as 2,
  memoryCost: ARGON2_MEMORY_KIB,
  timeCost: ARGON2_TIME_COST,
  parallelism: ARGON2_PARALLELISM,
};

/** Argon2id password hashing. Passwords are NFC-normalized on the way in, for hashing and checking alike. */
@Injectable()
export class PasswordHasher {
  /** A valid hash of a password nobody knows, for the "unknown email" path of login. */
  readonly dummyHash = DUMMY_PASSWORD_HASH;

  /** The PHC string ($argon2id$v=19$m=...,t=...,p=...$salt$hash), with a fresh random salt. */
  async hash(password: string): Promise<string> {
    if (passwordLength(password) > PASSWORD_MAX_LENGTH) {
      throw new RangeError(`password is longer than ${PASSWORD_MAX_LENGTH} characters`);
    }
    return hash(normalizePassword(password), PARAMS);
  }

  /**
   * True only if `password` matches `storedHash`. It never throws: a malformed hash, an empty
   * one, or an over-long password simply gives false (the length check is the same for known
   * and unknown accounts, so it reveals nothing about accounts).
   */
  async verify(storedHash: string, password: string): Promise<boolean> {
    if (typeof storedHash !== 'string' || typeof password !== 'string') return false;
    if (passwordLength(password) > PASSWORD_MAX_LENGTH) return false;
    try {
      return await verify(storedHash, normalizePassword(password));
    } catch {
      return false;
    }
  }

  /** True when the stored hash was made with different parameters than the current ones (or cannot be read). */
  needsRehash(storedHash: string): boolean {
    try {
      const used = parseOptions(storedHash);
      return (
        used.algorithm !== PARAMS.algorithm ||
        used.memoryCost !== PARAMS.memoryCost ||
        used.timeCost !== PARAMS.timeCost ||
        used.parallelism !== PARAMS.parallelism
      );
    } catch {
      return true;
    }
  }
}
