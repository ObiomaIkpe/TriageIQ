import { extractBearerKey, findClient } from './api-key.js';
import type { RegisteredClient } from './auth.types.js';
import { hashKey } from './client-key.js';

const KEY_A = 'tiq_key-for-alice';
const KEY_B = 'tiq_key-for-bob';
const CLIENTS: RegisteredClient[] = [
  { name: 'alice', role: 'submitter', key_sha256: hashKey(KEY_A) },
  { name: 'bob', role: 'reviewer', key_sha256: hashKey(KEY_B) },
];

describe('extractBearerKey', () => {
  it.each([
    ['Bearer tiq_abc', 'tiq_abc'],
    ['bearer tiq_abc', 'tiq_abc'],
    ['BEARER tiq_abc', 'tiq_abc'],
    ['  Bearer tiq_abc  ', 'tiq_abc'],
    ['Bearer   tiq_abc', 'tiq_abc'],
  ])('%j -> %s', (header, key) => {
    expect(extractBearerKey(header)).toBe(key);
  });

  it.each([
    undefined,
    '',
    'Bearer',
    'Bearer ',
    'tiq_abc',
    'Basic dGllcjp4',
    'Bearer a b',
    'Bearer tiq_abc,Bearer tiq_def',
    'Bearer tiqé',
    'Bearer ' + 'a'.repeat(201),
    ['Bearer tiq_a', 'Bearer tiq_b'],
  ])('%j -> undefined (malformed)', (header) => {
    expect(extractBearerKey(header as string)).toBeUndefined();
  });

  it('accepts a key of exactly 200 characters', () => {
    expect(extractBearerKey('Bearer ' + 'a'.repeat(200))).toHaveLength(200);
  });
});

describe('findClient', () => {
  it('finds the client whose key hashes to the registered hash', () => {
    expect(findClient(CLIENTS, KEY_A)?.name).toBe('alice');
    expect(findClient(CLIENTS, KEY_B)?.name).toBe('bob');
    expect(findClient(CLIENTS, KEY_B)?.role).toBe('reviewer');
  });

  it.each(['tiq_key-for-alicE', 'tiq_key-for-alice ', '', 'tiq', KEY_A.toUpperCase()])(
    'an unknown or altered key (%j) finds nothing',
    (key) => {
      expect(findClient(CLIENTS, key)).toBeUndefined();
    },
  );

  it('the hash of a key is not accepted as the key', () => {
    expect(findClient(CLIENTS, hashKey(KEY_A))).toBeUndefined();
  });

  it('compares against EVERY registered hash, even after a match (no early exit)', () => {
    const reads: string[] = [];
    const watched = CLIENTS.map((client) => ({
      name: client.name,
      role: client.role,
      get key_sha256() {
        reads.push(client.name);
        return client.key_sha256;
      },
    })) as RegisteredClient[];
    findClient(watched, KEY_A); // matches the FIRST entry
    expect(reads).toEqual(['alice', 'bob']);
  });

  it('uses a constant-time comparison (crypto.timingSafeEqual), not === on strings', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./api-key.ts', import.meta.url), 'utf8');
    expect(source).toContain('timingSafeEqual');
    expect(source).not.toMatch(/key_sha256\s*===|===\s*[a-z.]*key_sha256/);
  });

  it('an empty registry finds nothing', () => {
    expect(findClient([], KEY_A)).toBeUndefined();
  });
});
