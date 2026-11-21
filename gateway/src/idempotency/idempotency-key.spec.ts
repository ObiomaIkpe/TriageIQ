import { fingerprintTicket, parseIdempotencyKey } from './idempotency-key.js';

describe('parseIdempotencyKey', () => {
  it('no header -> no key, and no problem', () => {
    expect(parseIdempotencyKey(undefined)).toEqual({ ok: true, key: undefined });
  });

  it.each(['a', 'order-1234', 'A_b.c:d-9', 'x'.repeat(100), '550e8400-e29b-41d4-a716-446655440000'])(
    'accepts %s',
    (key) => {
      expect(parseIdempotencyKey(key)).toEqual({ ok: true, key });
    },
  );

  it.each([
    '', // present but empty
    'x'.repeat(101),
    'has space',
    'comma,joined',
    'semi;colon',
    'slash/inside',
    'unicodé',
    'new\nline',
    'tab\t',
    'SECRETVALUE!',
  ])('rejects %j without echoing it', (key) => {
    const result = parseIdempotencyKey(key);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(result).toEqual({
      ok: false,
      problems: [
        { field: 'Idempotency-Key', problem: 'must be 1 to 100 characters: letters, digits, _ . : -' },
      ],
    });
  });

  it('a header that arrives as an array (not a plain string) is rejected', () => {
    expect(parseIdempotencyKey(['a', 'b']).ok).toBe(false);
  });
});

describe('fingerprintTicket', () => {
  const base = { subject: 'Cannot log in', body: 'I forgot my password.', customer_id: 'c1' };

  it('is a 64-character hex SHA-256 and is stable', () => {
    expect(fingerprintTicket(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprintTicket(base)).toBe(fingerprintTicket({ ...base }));
  });

  it('does not depend on the order the fields were written in', () => {
    const shuffled = { customer_id: 'c1', body: base.body, subject: base.subject };
    expect(fingerprintTicket(shuffled)).toBe(fingerprintTicket(base));
  });

  it('a ticket without customer_id differs from one with it, and is stable', () => {
    const without = { subject: base.subject, body: base.body };
    expect(fingerprintTicket(without)).toBe(fingerprintTicket({ ...without }));
    expect(fingerprintTicket(without)).not.toBe(fingerprintTicket(base));
  });

  it.each([
    ['subject', { subject: 'Cannot log in!' }],
    ['body', { body: 'I forgot my password' }],
    ['customer_id', { customer_id: 'c2' }],
    ['subject case', { subject: 'cannot log in' }],
    ['a field moved into another', { subject: 'I forgot my password.', body: 'Cannot log in' }],
  ])('any change to %s changes the fingerprint', (_name, change) => {
    expect(fingerprintTicket({ ...base, ...change })).not.toBe(fingerprintTicket(base));
  });

  it('fields cannot be shifted into each other to collide', () => {
    expect(fingerprintTicket({ subject: 'ab', body: 'c' })).not.toBe(
      fingerprintTicket({ subject: 'a', body: 'bc' }),
    );
  });

  it('trimmed values are what is hashed: the schema trims, so padded input matches', async () => {
    const { parseTicket } = await import('../tickets/ticket.schema.js');
    const a = parseTicket({ subject: '  Cannot log in ', body: '\nI forgot my password.\n', customer_id: 'c1' });
    const b = parseTicket({ subject: 'Cannot log in', body: 'I forgot my password.', customer_id: 'c1' });
    if (!a.ok || !b.ok) throw new Error('both should be valid');
    expect(fingerprintTicket(a.data)).toBe(fingerprintTicket(b.data));
  });
});
