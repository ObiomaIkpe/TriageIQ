import { parseOptions } from '@node-rs/argon2';
import { PasswordHasher } from './password-hasher.js';
import {
  ARGON2_MEMORY_KIB,
  ARGON2_PARALLELISM,
  ARGON2_TIME_COST,
  ARGON2ID,
  DUMMY_PASSWORD_HASH,
} from './password.constants.js';

const hasher = new PasswordHasher();
const PASSWORD = 'correct horse battery staple';

describe('PasswordHasher', () => {
  it('uses the OWASP minimum Argon2id profile: 19456 KiB, 2 passes, 1 lane', () => {
    expect(ARGON2_MEMORY_KIB).toBe(19456);
    expect(ARGON2_TIME_COST).toBe(2);
    expect(ARGON2_PARALLELISM).toBe(1);
  });

  it('hash() makes a PHC string with the parameters inside it', async () => {
    const hash = await hasher.hash(PASSWORD);
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    const used = parseOptions(hash);
    expect([used.algorithm, used.memoryCost, used.timeCost, used.parallelism]).toEqual([ARGON2ID, 19456, 2, 1]);
  });

  it('the hash never contains the password', async () => {
    expect(await hasher.hash(PASSWORD)).not.toContain('horse');
  });

  it('the same password hashes differently every time (random salt), and both verify', async () => {
    const [a, b] = await Promise.all([hasher.hash(PASSWORD), hasher.hash(PASSWORD)]);
    expect(a).not.toBe(b);
    expect(await hasher.verify(a, PASSWORD)).toBe(true);
    expect(await hasher.verify(b, PASSWORD)).toBe(true);
  });

  describe('verify()', () => {
    it('round trip: the right password is true', async () => {
      expect(await hasher.verify(await hasher.hash(PASSWORD), PASSWORD)).toBe(true);
    });

    it.each(['wrong password here', PASSWORD + ' ', PASSWORD.toUpperCase(), '', ' '])(
      'a wrong password (%j) is false',
      async (wrong) => {
        const hash = await hasher.hash(PASSWORD);
        expect(await hasher.verify(hash, wrong)).toBe(false);
      },
    );

    it.each([
      '',
      'not a hash',
      '$argon2id$',
      '$argon2id$v=19$m=19456,t=2,p=1$bad$bad',
      '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ012345', // bcrypt, not argon2
      '$argon2id$v=19$m=0,t=0,p=0$AAAA$AAAA',
      'x'.repeat(10_000),
      '\u0000',
    ])('a malformed stored hash (%j) returns false and never throws', async (bad) => {
      await expect(hasher.verify(bad, PASSWORD)).resolves.toBe(false);
    });

    it('non-string input returns false instead of throwing', async () => {
      await expect(hasher.verify(undefined as unknown as string, PASSWORD)).resolves.toBe(false);
      await expect(hasher.verify('x', null as unknown as string)).resolves.toBe(false);
    });

    it('an over-long password is false at once, without hashing it (hashing-DoS guard)', async () => {
      const hash = await hasher.hash(PASSWORD);
      const started = Date.now();
      expect(await hasher.verify(hash, 'a'.repeat(100_000))).toBe(false);
      expect(Date.now() - started).toBeLessThan(20);
    });

    it('a password typed with decomposed accents verifies against the composed one (NFC)', async () => {
      const hash = await hasher.hash('café society rules'); // composed é
      expect(await hasher.verify(hash, 'café society rules')).toBe(true); // e + combining accent
    });
  });

  it('hash() refuses a password above 128 characters', async () => {
    await expect(hasher.hash('a'.repeat(129))).rejects.toThrow(RangeError);
    await expect(hasher.hash('a'.repeat(128))).resolves.toMatch(/^\$argon2id\$/);
  });

  describe('needsRehash()', () => {
    it('false for a hash made with the current parameters', async () => {
      expect(hasher.needsRehash(await hasher.hash(PASSWORD))).toBe(false);
    });

    it.each([
      ['more memory', '$argon2id$v=19$m=65536,t=2,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'],
      ['more passes', '$argon2id$v=19$m=19456,t=3,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'],
      ['more lanes', '$argon2id$v=19$m=19456,t=2,p=4$c29tZXNhbHQ$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'],
      ['argon2i instead of argon2id', '$argon2i$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g'],
    ])('true when the stored hash has %s', (_label, stored) => {
      expect(hasher.needsRehash(stored)).toBe(true);
    });

    it('true for something that is not a hash at all (it cannot be trusted as current)', () => {
      expect(hasher.needsRehash('garbage')).toBe(true);
      expect(hasher.needsRehash('')).toBe(true);
    });
  });

  describe('the dummy hash (for the constant-time unknown-email path)', () => {
    it('is exposed on the hasher', () => {
      expect(hasher.dummyHash).toBe(DUMMY_PASSWORD_HASH);
    });

    it('is a real Argon2id hash with the CURRENT parameters (regenerate it when they change)', () => {
      expect(DUMMY_PASSWORD_HASH).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(hasher.needsRehash(DUMMY_PASSWORD_HASH)).toBe(false);
    });

    it('verifies as false for any password, so it can never log anyone in', async () => {
      for (const guess of ['', 'password1234', PASSWORD, 'dummy', DUMMY_PASSWORD_HASH]) {
        expect(await hasher.verify(DUMMY_PASSWORD_HASH, guess)).toBe(false);
      }
    });

    it('costs the same as a real hash to check: it was made with exactly the same parameters', async () => {
      const real = parseOptions(await hasher.hash(PASSWORD));
      const dummy = parseOptions(DUMMY_PASSWORD_HASH);
      expect([dummy.algorithm, dummy.memoryCost, dummy.timeCost, dummy.parallelism, dummy.outputLen]).toEqual([
        real.algorithm,
        real.memoryCost,
        real.timeCost,
        real.parallelism,
        real.outputLen,
      ]);
    });
  });
});
