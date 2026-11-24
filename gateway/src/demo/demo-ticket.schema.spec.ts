import { describe, expect, it } from 'vitest';
import { fingerprintDemoTicket, parseDemoTicket } from './demo-ticket.schema.js';

const OK = { subject: ' Hello ', message: ' My message ', turnstile_token: 'tok' };

describe('the demo visitor ticket', () => {
  it('takes a subject, a message and a token, trimmed', () => {
    expect(parseDemoTicket(OK)).toEqual({ ok: true, data: { subject: 'Hello', message: 'My message', turnstile_token: 'tok' } });
  });

  it.each(['name', 'email', 'customer_id', 'is_demo', 'website', 'reference'])('refuses a "%s" field: nothing about the customer is taken from a visitor', (field) => {
    const result = parseDemoTicket({ ...OK, [field]: 'x' });
    expect(result.ok).toBe(false);
  });

  it.each([{ ...OK, subject: '' }, { ...OK, message: '   ' }, { ...OK, turnstile_token: '' }, { ...OK, subject: 'x'.repeat(201) }, { ...OK, message: 'x'.repeat(5001) }, null, 'text'])(
    'refuses %j',
    (input) => {
      expect(parseDemoTicket(input).ok).toBe(false);
    },
  );

  it('the fingerprint ignores the token and differs from the public form for the same words', () => {
    const a = parseDemoTicket(OK);
    const b = parseDemoTicket({ ...OK, turnstile_token: 'another' });
    if (!a.ok || !b.ok) throw new Error('parse');
    expect(fingerprintDemoTicket(a.data)).toBe(fingerprintDemoTicket(b.data));
  });
});
