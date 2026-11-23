import { describe, expect, it } from 'vitest';
import { cleanSubject, isPlainAddress, messageIdFor, replyBody, replySubject, SUBJECT_MAX } from './reply-email.js';

describe('the outgoing reply', () => {
  it('"Re: <subject> [<reference>]"', () => {
    expect(replySubject('Cannot log in', 'TKT-ABC234')).toBe('Re: Cannot log in [TKT-ABC234]');
  });

  it.each([
    ['CR and LF', 'Hi\r\nBcc: attacker@evil.example', 'Hi Bcc: attacker@evil.example'],
    ['LF only', 'a\nb', 'a b'],
    ['CR only', 'a\rb', 'a b'],
    ['tab, NUL, DEL and other control characters', 'a\tb\u0000c\u007fd\u0007e', 'a b c d e'],
    ['Unicode line and paragraph separators', 'a b c', 'a b c'],
    ['runs of whitespace', '  a   b  ', 'a b'],
  ])('header injection: %s is flattened to spaces', (_name, input, expected) => {
    const cleaned = cleanSubject(input);
    expect(cleaned).toBe(expected);
    expect(replySubject(input, 'TKT-ABC234')).not.toMatch(/[\r\n]/);
  });

  it('caps the length of a long subject', () => {
    const subject = cleanSubject('x'.repeat(5000));
    expect(subject.length).toBeLessThanOrEqual(SUBJECT_MAX);
    expect(subject.endsWith('…')).toBe(true);
  });

  it('keeps non-ASCII text', () => {
    expect(cleanSubject('Ọbiọma Ụzọ — 你好')).toBe('Ọbiọma Ụzọ — 你好');
  });

  it('the body is the reply, then a footer with the reference; plain text', () => {
    expect(replyBody('Your lockout clears after 1 hour.\n\n', 'TKT-ABC234')).toBe('Your lockout clears after 1 hour.\n\n--\nReference: TKT-ABC234\n');
  });

  it('the Message-ID is deterministic: <ticket_id@triageiq>', () => {
    expect(messageIdFor('3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34')).toBe('<3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34@triageiq>');
  });

  it.each([
    ['ada@example.com', true],
    ['first.last+tag@sub.example.co', true],
    ['a@b', false],
    ['a b@example.com', false],
    ['a@example.com\r\nBcc: x@y.z', false],
    ['"quoted"@example.com', false],
    ['a@example.com, b@example.com', false],
    ['<a@example.com>', false],
    ['a@@example.com', false],
  ])('isPlainAddress(%j) = %s', (address, expected) => {
    expect(isPlainAddress(address)).toBe(expected);
  });
});
