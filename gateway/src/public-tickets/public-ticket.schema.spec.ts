import { describe, expect, it } from 'vitest';
import { BODY_MAX, SUBJECT_MAX } from '../tickets/ticket.schema.js';
import { fingerprintPublicTicket, parsePublicTicket } from './public-ticket.schema.js';

const GOOD = { name: 'Ada', email: 'ada@example.com', subject: 'Hi', message: 'Help', turnstile_token: 'tok' };
const ok = (over: Record<string, unknown>) => parsePublicTicket({ ...GOOD, ...over }).ok;

describe('parsePublicTicket', () => {
  it('accepts a good body, trims text and lower-cases the email', () => {
    const r = parsePublicTicket({ ...GOOD, name: '  Ọbiọma ', email: '  Ada@Example.COM ', subject: ' s ', message: ' m ' });
    expect(r).toEqual({ ok: true, data: expect.objectContaining({ name: 'Ọbiọma', email: 'ada@example.com', subject: 's', message: 'm' }) });
  });

  it.each([
    ['name', 'x'.repeat(100), true], ['name', 'x'.repeat(101), false], ['name', '   ', false], ['name', '', false],
    ['subject', 'x'.repeat(SUBJECT_MAX), true], ['subject', 'x'.repeat(SUBJECT_MAX + 1), false], ['subject', ' ', false],
    ['message', 'x'.repeat(BODY_MAX), true], ['message', 'x'.repeat(BODY_MAX + 1), false], ['message', '', false],
    ['email', `${'a'.repeat(242)}@example.com`, true], ['email', `${'a'.repeat(243)}@example.com`, false],
    ['email', 'not-an-email', false], ['email', '', false], ['email', 'a@b', false],
    ['turnstile_token', 'x'.repeat(2048), true], ['turnstile_token', 'x'.repeat(2049), false], ['turnstile_token', '', false],
    ['website', '', true], ['website', 'http://spam', true], ['website', 5, false],
  ])('%s = %j -> ok %s', (field, value, expected) => {
    expect(ok({ [field]: value })).toBe(expected);
  });

  it('subject and message limits are the API ticket limits', () => {
    expect(SUBJECT_MAX).toBe(200);
    expect(BODY_MAX).toBe(5000);
  });

  it.each(['name', 'email', 'subject', 'message', 'turnstile_token'])('%s is required', (field) => {
    const { [field]: _gone, ...rest } = GOOD as Record<string, unknown>;
    expect(parsePublicTicket(rest).ok).toBe(false);
  });

  it('refuses an unknown field and says which, without echoing values', () => {
    const r = parsePublicTicket({ ...GOOD, extra: 'SECRETVALUE', customer_id: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems).toContainEqual({ field: 'extra', problem: 'unknown field' });
      expect(JSON.stringify(r.problems)).not.toContain('SECRETVALUE');
    }
  });

  it.each([null, 'x', 5, [], undefined])('a non-object body %j is refused', (body) => {
    expect(parsePublicTicket(body).ok).toBe(false);
  });
});

describe('fingerprintPublicTicket', () => {
  const fp = (over: Record<string, unknown>) => {
    const r = parsePublicTicket({ ...GOOD, ...over });
    if (!r.ok) throw new Error('bad fixture');
    return fingerprintPublicTicket(r.data);
  };

  it('ignores the turnstile token and the honeypot', () => {
    expect(fp({ turnstile_token: 'another-token' })).toBe(fp({}));
    expect(fp({ website: 'spam' })).toBe(fp({ website: undefined }));
  });

  it('changes with each content field, and ignores whitespace and email case', () => {
    const base = fp({});
    for (const over of [{ name: 'Bob' }, { email: 'b@example.com' }, { subject: 'Other' }, { message: 'Other' }]) {
      expect(fp(over)).not.toBe(base);
    }
    expect(fp({ email: ' ADA@example.com ', message: ' Help ' })).toBe(base);
  });
});
