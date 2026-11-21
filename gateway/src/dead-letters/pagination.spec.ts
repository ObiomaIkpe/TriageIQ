import { parsePage } from './pagination.js';

describe('parsePage', () => {
  it('defaults to limit 20, offset 0', () => {
    expect(parsePage({})).toEqual({ ok: true, limit: 20, offset: 0 });
  });

  it('accepts the edges', () => {
    expect(parsePage({ limit: '1', offset: '0' })).toEqual({ ok: true, limit: 1, offset: 0 });
    expect(parsePage({ limit: '100', offset: '40' })).toEqual({ ok: true, limit: 100, offset: 40 });
  });

  it.each(['0', '101', '-1', '5.5', '1e2', ' 5', 'abc', '', '0x10', '99999999999'])(
    'limit=%j is rejected',
    (limit) => {
      expect(parsePage({ limit })).toEqual({
        ok: false,
        problems: [{ field: 'limit', problem: 'must be a whole number from 1 to 100' }],
      });
    },
  );

  it.each(['-1', '1.5', 'abc', '', '1000001'])('offset=%j is rejected', (offset) => {
    expect(parsePage({ offset })).toMatchObject({ ok: false, problems: [{ field: 'offset' }] });
  });

  it('rejects repeated parameters (an array) and non-strings', () => {
    expect(parsePage({ limit: ['1', '2'] })).toMatchObject({ ok: false });
    expect(parsePage({ offset: { a: 1 } })).toMatchObject({ ok: false });
  });

  it('reports both fields when both are bad, and never the value', () => {
    const result = parsePage({ limit: 'SECRETVALUE', offset: 'SECRETVALUE2' });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect((result as { problems: unknown[] }).problems).toHaveLength(2);
  });

  it('ignores unrelated parameters', () => {
    expect(parsePage({ other: 'x', limit: '5' })).toEqual({ ok: true, limit: 5, offset: 0 });
  });
});
