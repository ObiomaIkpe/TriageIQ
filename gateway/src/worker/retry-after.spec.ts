import { parseRetryAfter } from './retry-after.js';

const NOW = Date.parse('2026-11-20T10:00:00Z');

describe('parseRetryAfter', () => {
  it('reads whole seconds', () => {
    expect(parseRetryAfter('30')).toBe(30);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('  120  ')).toBe(120);
  });

  it('reads an HTTP date as seconds from now', () => {
    expect(parseRetryAfter('Fri, 20 Nov 2026 10:00:45 GMT', NOW)).toBe(45);
  });

  it('rounds a part-second date up', () => {
    expect(parseRetryAfter('Fri, 20 Nov 2026 10:00:00 GMT', NOW - 500)).toBe(1);
  });

  it('a date in the past is 0, not negative', () => {
    expect(parseRetryAfter('Fri, 20 Nov 2026 09:00:00 GMT', NOW)).toBe(0);
  });

  it.each([null, undefined, '', '   '])('missing (%s) -> undefined', (value) => {
    expect(parseRetryAfter(value)).toBeUndefined();
  });

  it.each(['soon', 'abc123', '12abc', '1.5', '1e3', '0x10', 'May 5', 'Fri, 99 Zzz 2026 10:00:00 GMT'])(
    'garbage %j -> undefined',
    (value) => {
      expect(parseRetryAfter(value, NOW)).toBeUndefined();
    },
  );

  it.each(['-1', '-30', ' -5 '])('negative %j -> undefined', (value) => {
    expect(parseRetryAfter(value)).toBeUndefined();
  });

  it('a number too big to be exact -> undefined', () => {
    expect(parseRetryAfter('99999999999999999999')).toBeUndefined();
  });
});
