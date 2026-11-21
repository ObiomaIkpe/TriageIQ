import { generateSessionToken, hashSessionToken, looksLikeSessionToken } from './session-token.js';

describe('generateSessionToken', () => {
  it('is 32 random bytes in base64url: 43 characters, URL and cookie safe', () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('is different every time (no collisions in 1000)', () => {
    expect(new Set(Array.from({ length: 1000 }, generateSessionToken)).size).toBe(1000);
  });
});

describe('hashSessionToken', () => {
  it('is a 64-character lower-case hex SHA-256 and is stable', () => {
    const hash = hashSessionToken('abc');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'); // SHA-256("abc")
    expect(hashSessionToken('abc')).toBe(hash);
  });

  it('never contains the token, and a one-character change gives a different hash', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).not.toContain(token.slice(0, 8));
    expect(hashSessionToken(token)).not.toBe(hashSessionToken(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')));
  });
});

describe('looksLikeSessionToken', () => {
  it('accepts a generated token', () => {
    expect(looksLikeSessionToken(generateSessionToken())).toBe(true);
  });

  it.each(['', 'short', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '!', 'a'.repeat(42) + ' ', '../'.repeat(15), undefined, null, 5, {}])(
    'refuses %j',
    (value) => {
      expect(looksLikeSessionToken(value)).toBe(false);
    },
  );
});
