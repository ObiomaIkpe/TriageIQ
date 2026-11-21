import { describe, expect, it } from 'vitest';
import { newReference, REFERENCE_ALPHABET, REFERENCE_PATTERN } from './reference.js';

describe('newReference', () => {
  it('matches the format Python makes: TKT- plus 6 of the 31 characters with no 0, O, 1, I or L', () => {
    for (let i = 0; i < 500; i += 1) expect(newReference()).toMatch(REFERENCE_PATTERN);
    expect(REFERENCE_ALPHABET).toBe('ABCDEFGHJKMNPQRSTUVWXYZ23456789'); // Python's ALPHABET, character for character
    expect(REFERENCE_ALPHABET).toHaveLength(31);
    expect('01OIL'.split('').some((c) => REFERENCE_ALPHABET.includes(c))).toBe(false);
  });

  it('is not constant', () => {
    expect(new Set(Array.from({ length: 50 }, newReference)).size).toBeGreaterThan(45);
  });

  it('the pattern refuses look-alikes, lower case and wrong lengths', () => {
    for (const bad of ['TKT-ABC23', 'TKT-ABC2345', 'tkt-ABC234', 'TKT-ABC23O', 'TKT-ABC231', 'ABC234', 'TKT-ABC234\n']) {
      expect(REFERENCE_PATTERN.test(bad)).toBe(false);
    }
  });
});
