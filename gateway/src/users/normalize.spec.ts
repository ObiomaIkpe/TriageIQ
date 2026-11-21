import { normalizeEmail, parseDisplayName, parseEmail } from './normalize.js';

describe('normalizeEmail', () => {
  it.each([
    ['Alice@Example.COM', 'alice@example.com'],
    ['  alice@example.com  ', 'alice@example.com'],
    ['\tAlice@Example.com\n', 'alice@example.com'],
    ['alice@example.com', 'alice@example.com'],
  ])('%j -> %j', (raw, expected) => {
    expect(normalizeEmail(raw)).toBe(expected);
  });

  it('is idempotent', () => {
    const once = normalizeEmail('  MiXed@Case.Org ');
    expect(normalizeEmail(once)).toBe(once);
  });
});

describe('parseEmail', () => {
  it('returns the trimmed, lower-cased address', () => {
    expect(parseEmail('  Reviewer@Example.com ')).toBe('reviewer@example.com');
  });

  it.each(['', 'nope', 'a@', '@b.com', 'a b@c.com', 'a@b', 'a@@b.com', `${'x'.repeat(250)}@e.com`])(
    'rejects %j',
    (raw) => {
      expect(parseEmail(raw)).toBeUndefined();
    },
  );

  it('accepts plus-addressing and subdomains', () => {
    expect(parseEmail('a+tag@mail.example.co.uk')).toBe('a+tag@mail.example.co.uk');
  });
});

describe('parseDisplayName', () => {
  it('trims', () => {
    expect(parseDisplayName('  Ada Lovelace ')).toBe('Ada Lovelace');
  });

  it('accepts 1 and 100 characters, counted as characters (an emoji is one)', () => {
    expect(parseDisplayName('A')).toBe('A');
    expect(parseDisplayName('x'.repeat(100))).toBe('x'.repeat(100));
    expect(parseDisplayName('😀'.repeat(100))).toBe('😀'.repeat(100));
  });

  it.each(['', '   ', 'x'.repeat(101), '😀'.repeat(101)])('rejects %j', (raw) => {
    expect(parseDisplayName(raw)).toBeUndefined();
  });
});
