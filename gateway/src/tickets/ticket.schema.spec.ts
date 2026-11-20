import { parseTicket, type ParseResult } from './ticket.schema.js';

const VALID = { subject: 'Cannot log in', body: 'I forgot my password.', customer_id: 'cust-42' };

/** A marker that must never show up in an error response. */
const SECRET = 'SECRETVALUE123';

function problems(input: unknown) {
  const result: ParseResult = parseTicket(input);
  if (result.ok) throw new Error('expected the ticket to be rejected');
  return result.problems;
}

describe('parseTicket', () => {
  it('accepts a valid ticket', () => {
    expect(parseTicket(VALID)).toEqual({ ok: true, data: VALID });
  });

  it('customer_id is optional', () => {
    const result = parseTicket({ subject: 'a', body: 'b' });
    expect(result).toEqual({ ok: true, data: { subject: 'a', body: 'b' } });
  });

  it('trims subject and body', () => {
    const result = parseTicket({ subject: '  Hi  ', body: '\n text \t' });
    expect(result).toEqual({ ok: true, data: { subject: 'Hi', body: 'text' } });
  });

  it('accepts the exact maximum lengths', () => {
    const result = parseTicket({
      subject: 'a'.repeat(200),
      body: 'b'.repeat(5000),
      customer_id: 'c'.repeat(100),
    });
    expect(result.ok).toBe(true);
  });

  it.each(['subject', 'body'])('%s missing -> "is required"', (field) => {
    const input: Record<string, unknown> = { ...VALID };
    delete input[field];
    expect(problems(input)).toEqual([{ field, problem: 'is required' }]);
  });

  it.each(['subject', 'body'])('%s empty or only spaces -> "must not be empty"', (field) => {
    expect(problems({ ...VALID, [field]: '' })).toEqual([{ field, problem: 'must not be empty' }]);
    expect(problems({ ...VALID, [field]: '   \n ' })).toEqual([
      { field, problem: 'must not be empty' },
    ]);
  });

  it.each([
    ['subject', 201, 200],
    ['body', 5001, 5000],
    ['customer_id', 101, 100],
  ])('%s of %i characters is too long (max %i)', (field, length, max) => {
    expect(problems({ ...VALID, [field]: 'x'.repeat(length) })).toEqual([
      { field, problem: `must be at most ${max} characters` },
    ]);
  });

  it.each(['subject', 'body', 'customer_id'])('%s that is not a string is rejected', (field) => {
    expect(problems({ ...VALID, [field]: 123 })).toEqual([{ field, problem: 'must be a string' }]);
  });

  it('rejects unknown fields, naming only the field', () => {
    expect(problems({ ...VALID, priority: 'high' })).toEqual([
      { field: 'priority', problem: 'unknown field' },
    ]);
  });

  it('rejects a body that is not an object', () => {
    for (const input of [undefined, null, 'text', 42, [VALID]]) {
      expect(problems(input)).toEqual([{ field: '(body)', problem: 'must be a JSON object' }]);
    }
  });

  it('reports every bad field at once', () => {
    const list = problems({ subject: '', extra: 1 });
    expect(list.map((p) => p.field).sort()).toEqual(['body', 'extra', 'subject']);
  });

  it('never echoes a submitted value in any message', () => {
    const cases: unknown[] = [
      { subject: SECRET.repeat(40), body: 'ok' },
      { subject: 'ok', body: SECRET.repeat(500) },
      { subject: 'ok', body: 'ok', customer_id: SECRET.repeat(20) },
      { subject: { nested: SECRET }, body: 'ok' },
      { subject: 'ok', body: ['x', SECRET] },
      { subject: 'ok', body: 'ok', customer_id: { id: SECRET } },
      [SECRET],
      SECRET,
    ];
    for (const input of cases) {
      expect(JSON.stringify(problems(input))).not.toContain(SECRET);
    }
  });

  it('cuts a very long unknown field name short', () => {
    const list = problems({ ...VALID, ['n'.repeat(500)]: 1 });
    expect(list[0].field.length).toBeLessThanOrEqual(50);
  });
});
