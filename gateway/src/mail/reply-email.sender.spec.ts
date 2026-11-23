import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeMailer, MemoryDeliveries, MemoryRecipientCounter } from '../../test/mail-fakes.js';
import { RetryableTriageError } from '../worker/triage.errors.js';
import { ERR_BUSY, ERR_LIMIT, ERR_NOT_APPROVED, ERR_REFUSED, ERR_TRIAGE_DOWN, ERR_UNREACHABLE } from './mail.constants.js';
import { MailError } from './mailer.js';
import { recipientKey } from './recipient-counter.js';
import { ReplyEmailSender } from './reply-email.sender.js';

const ID = '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34';
const ADDRESS = 'private.person@example.com';
const REPLY = 'Your lockout clears after 1 hour. SECRET-REPLY-TEXT';
const SUBJECT = 'Cannot log in SECRET-SUBJECT';

function setup(over: { ticket?: Record<string, unknown> | 'down' | 404; max?: number } = {}) {
  const deliveries = new MemoryDeliveries();
  const mailer = new FakeMailer();
  const counter = new MemoryRecipientCounter();
  const state = {
    ticket: (over.ticket ?? {}) as Record<string, unknown> | 'down' | 404,
  };
  const triage = {
    call: async () => {
      if (state.ticket === 'down') throw new Error('unavailable');
      if (state.ticket === 404) return { status: 404, body: {} };
      return { status: 200, body: { ticket_id: ID, reference: 'TKT-ABC234', status: 'approved', subject: SUBJECT, final_reply: REPLY, customer_email: ADDRESS, ...state.ticket } };
    },
  };
  const sender = new ReplyEmailSender(new ConfigService({ MAIL_MAX_PER_RECIPIENT_PER_DAY: over.max ?? 3 }) as never, deliveries as never, triage as never, mailer, counter);
  void deliveries.insert(ID, 'TKT-ABC234', 'queued');
  return { deliveries, mailer, counter, sender, state };
}
const attempt = (n = 0, max = 8) => ({ ticketId: ID, attemptsMade: n, attemptsMax: max });
const row = (t: ReturnType<typeof setup>) => t.deliveries.rows.get(ID)!;

describe('ReplyEmailSender', () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(Logger.prototype, m).mockImplementation((msg: unknown) => void lines.push(String(msg)));
  });
  afterEach(() => vi.restoreAllMocks());

  it('happy path: sends the final reply to the customer, marks the row sent with the attempt count', async () => {
    const t = setup();
    expect(await t.sender.send(attempt())).toBe('sent');
    expect(t.mailer.sent).toEqual([{ to: ADDRESS, subject: `Re: ${SUBJECT} [TKT-ABC234]`, text: `${REPLY}\n\n--\nReference: TKT-ABC234\n`, messageId: `<${ID}@triageiq>` }]);
    expect(row(t)).toMatchObject({ status: 'sent', attempts: 1, last_error: null });
    expect(row(t).sent_at).toBeInstanceOf(Date);
  });

  it('an edited ticket is sent as well', async () => {
    const t = setup({ ticket: { status: 'edited' } });
    expect(await t.sender.send(attempt())).toBe('sent');
  });

  it('a delivery that is already sent is skipped: nothing is fetched or sent again', async () => {
    const t = setup();
    await t.sender.send(attempt());
    expect(await t.sender.send(attempt(1))).toBe('already_sent');
    expect(t.mailer.sent).toHaveLength(1);
    expect(row(t).attempts).toBe(1);
  });

  it('a header-injecting subject is flattened before it reaches the mailer', async () => {
    const t = setup({ ticket: { subject: 'Hi\r\nBcc: attacker@evil.example' } });
    await t.sender.send(attempt());
    expect(t.mailer.sent[0]?.subject).toBe('Re: Hi Bcc: attacker@evil.example [TKT-ABC234]');
    expect(t.mailer.sent[0]?.subject).not.toMatch(/[\r\n]/);
  });

  it('an SMTP 4xx / connection failure is retried: the row stays queued with a fixed phrase, and the recipient slot is given back', async () => {
    const t = setup();
    t.mailer.failures = [new MailError(ERR_BUSY, true)];
    await expect(t.sender.send(attempt(0))).rejects.toBeInstanceOf(RetryableTriageError);
    expect(row(t)).toMatchObject({ status: 'queued', attempts: 1, last_error: ERR_BUSY });
    expect([...t.counter.counts.values()]).toEqual([0]); // the slot was released

    t.mailer.failures = [];
    expect(await t.sender.send(attempt(1))).toBe('sent'); // the next try works
    expect(row(t)).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('an SMTP 5xx is unrecoverable: failed at once, with a sanitised reason', async () => {
    const t = setup();
    t.mailer.failures = [new MailError(ERR_REFUSED, false)];
    await expect(t.sender.send(attempt(0))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(row(t)).toMatchObject({ status: 'failed', attempts: 1, last_error: ERR_REFUSED });
  });

  it('the LAST attempt failing marks the delivery failed (no more retries) with a sanitised reason: no address, no body', async () => {
    const t = setup();
    t.mailer.failures = [new MailError(ERR_UNREACHABLE, true)];
    await expect(t.sender.send(attempt(7, 8))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(row(t)).toMatchObject({ status: 'failed', last_error: ERR_UNREACHABLE });
    expect(JSON.stringify(row(t))).not.toContain(ADDRESS);
    expect(JSON.stringify(row(t))).not.toContain('SECRET');
  });

  it('per-recipient limit: the 4th reply to one address in a day is not sent and the delivery fails with "recipient daily limit"', async () => {
    const t = setup({ max: 3 });
    for (let i = 0; i < 3; i += 1) {
      const id = `00000000-0000-4000-8000-00000000000${i}`;
      await t.deliveries.insert(id, `TKT-AAAAA${i + 2}`, 'queued');
      expect(await t.sender.send({ ...attempt(), ticketId: id })).toBe('sent');
    }
    await expect(t.sender.send(attempt())).rejects.toBeInstanceOf(UnrecoverableError); // the 4th, for ID
    expect(t.mailer.sent).toHaveLength(3);
    expect(row(t)).toMatchObject({ status: 'failed', last_error: ERR_LIMIT });
  });

  it('the counter key is a hash of the lower-cased address: it contains no part of the address, and case does not matter', () => {
    const key = recipientKey('2026-11-23', 'Private.Person@Example.com');
    expect(key).toBe(recipientKey('2026-11-23', 'private.person@example.com'));
    expect(key).toMatch(/^mail:rcpt:2026-11-23:[0-9a-f]{64}$/);
    expect(key.toLowerCase()).not.toContain('private');
    expect(key.toLowerCase()).not.toContain('example');
    expect(key).not.toBe(recipientKey('2026-11-24', 'private.person@example.com')); // a new day, a new counter
  });

  it('the keys the sender really used hold no address either', async () => {
    const t = setup();
    await t.sender.send(attempt());
    for (const key of t.counter.counts.keys()) expect(key).not.toMatch(/private|example|@/);
  });

  it('a ticket that is not approved (or has no reply) is never emailed: unrecoverable', async () => {
    for (const ticket of [{ status: 'rejected' }, { status: 'pending_review' }, { status: 'triaged' }, { final_reply: '  ' }, { final_reply: null }]) {
      const t = setup({ ticket });
      await expect(t.sender.send(attempt())).rejects.toBeInstanceOf(UnrecoverableError);
      expect(t.mailer.sent).toEqual([]);
      expect(row(t)).toMatchObject({ status: 'failed', last_error: ERR_NOT_APPROVED });
    }
  });

  it('a ticket that has lost its email is skipped_no_email, not failed', async () => {
    const t = setup({ ticket: { customer_email: null } });
    expect(await t.sender.send(attempt())).toBe('skipped_no_email');
    expect(row(t).status).toBe('skipped_no_email');
    expect(t.mailer.sent).toEqual([]);
  });

  it('an address that is not a plain address is refused (never handed to the mail library)', async () => {
    const t = setup({ ticket: { customer_email: 'a@example.com\r\nBcc: x@y.z' } });
    await expect(t.sender.send(attempt())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(t.mailer.sent).toEqual([]);
  });

  it('the Python service being unreachable is retried (and fails for good only on the last attempt)', async () => {
    const t = setup({ ticket: 'down' });
    await expect(t.sender.send(attempt(0))).rejects.toBeInstanceOf(RetryableTriageError);
    expect(row(t)).toMatchObject({ status: 'queued', last_error: ERR_TRIAGE_DOWN });
    await expect(t.sender.send(attempt(7, 8))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(row(t).status).toBe('failed');
  });

  it('a leftover job for a delivery that is no longer queued (failed, or retried and reset) does nothing', async () => {
    const t = setup();
    row(t).status = 'failed';
    expect(await t.sender.send(attempt())).toBe('stale');
    expect(t.mailer.sent).toEqual([]);
    expect(await setup().sender.send({ ...attempt(), ticketId: '00000000-0000-4000-8000-000000000099' })).toBe('skipped_no_row');
  });

  it('logs the reference, the ticket id, the outcome and the attempt, and NEVER the address, the subject or the body', async () => {
    const t = setup();
    t.mailer.failures = [new MailError(ERR_BUSY, true)];
    await t.sender.send(attempt(0)).catch(() => undefined);
    await t.sender.send(attempt(1));
    await t.sender.send(attempt(2)); // already sent
    const log = lines.join('\n');
    expect(log).toMatch(/reply_email outcome=sent reference=TKT-ABC234 ticket=3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34 attempt=2/);
    expect(log).toMatch(/outcome=retry/);
    for (const forbidden of [ADDRESS, 'private.person', 'example.com', 'SECRET-SUBJECT', 'SECRET-REPLY-TEXT', 'lockout']) expect(log).not.toContain(forbidden);
  });
});
