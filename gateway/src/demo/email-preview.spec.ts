import { describe, expect, it } from 'vitest';
import { replyBody, replySubject } from '../mail/reply-email.js';
import { demoEmailPreview } from './email-preview.js';

const ticket = (over: Record<string, unknown> = {}) => ({
  is_demo: true,
  status: 'approved',
  subject: 'Locked out',
  reference: 'TKT-ABC234',
  final_reply: 'Hello,\n\nWait one hour.',
  customer_email: 'maya@example.com',
  ...over,
});

describe('demoEmailPreview', () => {
  it('is exactly the subject and body the real mail worker would send', () => {
    expect(demoEmailPreview(ticket())).toEqual({
      to: 'maya@example.com',
      subject: replySubject('Locked out', 'TKT-ABC234'),
      body: replyBody('Hello,\n\nWait one hour.', 'TKT-ABC234'),
    });
    expect(demoEmailPreview(ticket())?.subject).toBe('Re: Locked out [TKT-ABC234]');
  });

  it('an edited ticket has one too', () => {
    expect(demoEmailPreview(ticket({ status: 'edited' }))).toBeDefined();
  });

  it.each([
    ['a REAL ticket (never previewed here)', { is_demo: false }],
    ['a ticket without the flag', { is_demo: undefined }],
    ['a rejected ticket', { status: 'rejected' }],
    ['a pending ticket', { status: 'pending_review' }],
    ['no reply text', { final_reply: null }],
    ['a blank reply', { final_reply: '   ' }],
  ])('has none for %s', (_label, over) => {
    expect(demoEmailPreview(ticket(over))).toBeUndefined();
  });

  it('flattens a header-injecting subject like the real worker does', () => {
    expect(demoEmailPreview(ticket({ subject: 'Hi\r\nBcc: x@evil.example' }))?.subject).not.toMatch(/[\r\n]/);
  });

  it.each([null, undefined, 'x', 7])('survives a body that is %j', (body) => {
    expect(demoEmailPreview(body)).toBeUndefined();
  });
});
