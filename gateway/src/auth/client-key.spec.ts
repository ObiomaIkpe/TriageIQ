import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { HASH_PATTERN, NAME_PATTERN, generateKey, hashKey, registryEntry } from './client-key.js';
import { parseClients } from '../config/clients.js';

describe('generateKey', () => {
  it('is "tiq_" and 32 random bytes in base64url (43 characters)', () => {
    const key = generateKey();
    expect(key).toMatch(/^tiq_[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(key.slice(4), 'base64url')).toHaveLength(32);
  });

  it('is different every time', () => {
    expect(new Set(Array.from({ length: 50 }, generateKey)).size).toBe(50);
  });
});

describe('hashKey', () => {
  it('is the SHA-256 of the key as 64 lowercase hex characters', () => {
    const hash = hashKey('tiq_abc');
    expect(hash).toMatch(HASH_PATTERN);
    expect(hash).toBe(createHash('sha256').update('tiq_abc').digest('hex'));
  });

  it('a one-character difference gives a different hash', () => {
    expect(hashKey('tiq_abc')).not.toBe(hashKey('tiq_abd'));
  });
});

describe('registryEntry', () => {
  it('has name, role and the hash of the key, and passes the registry validation', () => {
    const key = generateKey();
    const entry = registryEntry('alice', 'submitter', key);
    expect(entry).toEqual({ name: 'alice', role: 'submitter', key_sha256: hashKey(key) });
    expect(JSON.stringify(entry)).not.toContain(key);
    expect(parseClients(JSON.stringify([entry])).ok).toBe(true);
  });

  it('the name pattern matches the registry rule', () => {
    expect(NAME_PATTERN.test('a-1')).toBe(true);
    expect(NAME_PATTERN.test('A')).toBe(false);
  });
});

describe('npm run make-client-key (scripts/make-client-key.ts)', () => {
  const run = (...args: string[]) =>
    spawnSync('node', ['scripts/make-client-key.ts', ...args], { encoding: 'utf8' });

  it('prints the key once, a warning, and the registry entry that matches it; writes no file', () => {
    const before = readdirSync('.').sort();
    const output = execFileSync('node', ['scripts/make-client-key.ts', 'ops-team', 'reviewer'], {
      encoding: 'utf8',
    });

    const key = /^  (tiq_[A-Za-z0-9_-]{43})$/m.exec(output)?.[1];
    expect(key).toBeDefined();
    expect(output.split(key as string)).toHaveLength(2); // the key appears exactly once
    expect(output).toMatch(/shown ONCE/);
    expect(output).toMatch(/cannot be recovered/);

    const entryLine = /^ {2}(\{.*\})$/m.exec(output)?.[1] as string;
    const entry = JSON.parse(entryLine) as Record<string, string>;
    expect(entry).toEqual({ name: 'ops-team', role: 'reviewer', key_sha256: hashKey(key as string) });
    expect(entryLine).not.toContain(key as string);
    expect(parseClients(`[${entryLine}]`).ok).toBe(true);
    expect(readdirSync('.').sort()).toEqual(before);
  });

  it.each([[[]], [['alice']], [['Bad_Name', 'submitter']], [['alice', 'admin']]])(
    'bad arguments %j -> usage on stderr, exit 1, no key printed',
    (args) => {
      const result = run(...(args as string[]));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Usage: npm run make-client-key -- <name> <role>');
      expect(result.stdout).not.toContain('tiq_');
    },
  );
});
