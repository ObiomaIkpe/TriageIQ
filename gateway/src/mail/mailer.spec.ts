import { afterEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { startFakeSmtp } from '../../test/mail-fakes.js';
import { ERR_BUSY, ERR_REFUSED, ERR_UNREACHABLE } from './mail.constants.js';
import { classifyMailError, MailError, NodemailerMailer } from './mailer.js';
import { messageIdFor, replyBody, replySubject } from './reply-email.js';

/** The REAL nodemailer, talking SMTP to a tiny fake server on a local port. */
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

function mailerFor(port: number, extra: Record<string, unknown> = {}) {
  const config = new ConfigService({ SMTP_HOST: '127.0.0.1', SMTP_PORT: port, SMTP_SECURE: false, SMTP_USER: '', SMTP_PASS: '', MAIL_FROM: 'TriageIQ Support <support@triageiq.local>', MAIL_REPLY_TO: '', ...extra });
  return new NodemailerMailer(config as never);
}
const TICKET = '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34';
const mail = (over: Record<string, string> = {}) => ({
  to: 'ada@example.com',
  subject: replySubject('Cannot log in', 'TKT-ABC234'),
  text: replyBody('Your lockout clears after 1 hour.', 'TKT-ABC234'),
  messageId: messageIdFor(TICKET),
  ...over,
});

describe('NodemailerMailer against a fake SMTP server', () => {
  it('delivers a PLAIN TEXT message with the sender, subject, deterministic Message-ID and reply text', async () => {
    const smtp = await startFakeSmtp();
    closers.push(smtp.close);
    await mailerFor(smtp.port, { MAIL_REPLY_TO: 'help@triageiq.local' }).send(mail());

    expect(smtp.messages).toHaveLength(1);
    const { raw, to, from } = smtp.messages[0]!;
    expect(to.join()).toContain('ada@example.com');
    expect(from).toContain('support@triageiq.local');
    expect(raw).toMatch(/^From: "?TriageIQ Support"? <support@triageiq.local>/m);
    expect(raw).toMatch(/^Reply-To: help@triageiq.local/m);
    expect(raw).toMatch(/^Subject: Re: Cannot log in \[TKT-ABC234\]/m);
    expect(raw).toContain(`Message-ID: <${TICKET}@triageiq>`);
    expect(raw).toMatch(/Content-Type: text\/plain/);
    expect(raw).not.toMatch(/text\/html/i);
    expect(raw).toContain('Your lockout clears after 1 hour.');
    expect(raw).toContain('Reference: TKT-ABC234');
  });

  it('a subject that tried to inject headers arrives as ONE harmless Subject line', async () => {
    const smtp = await startFakeSmtp();
    closers.push(smtp.close);
    await mailerFor(smtp.port).send(mail({ subject: replySubject('Hi\r\nBcc: attacker@evil.example\r\n\r\nInjected body', 'TKT-ABC234') }));
    const headers = smtp.messages[0]!.raw.split('\r\n\r\n')[0]!;
    expect(headers).not.toMatch(/^Bcc:/im);
    expect(headers.match(/^Subject:/gim)).toHaveLength(1);
    expect(smtp.messages[0]!.to).toHaveLength(1);
  });

  it('a 4xx answer is a retryable "busy" failure', async () => {
    const smtp = await startFakeSmtp({ rcpt: () => '451 4.7.1 try again later for ada@example.com' });
    closers.push(smtp.close);
    const error = await mailerFor(smtp.port).send(mail()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MailError);
    expect(error).toMatchObject({ reason: ERR_BUSY, retryable: true });
    expect((error as Error).message).not.toContain('ada@example.com'); // the server's text (which echoes the address) is not kept
  });

  it('a 5xx answer is a final "refused" failure', async () => {
    const smtp = await startFakeSmtp({ rcpt: () => '550 5.1.1 no such user ada@example.com' });
    closers.push(smtp.close);
    const error = await mailerFor(smtp.port).send(mail()).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: ERR_REFUSED, retryable: false });
    expect((error as Error).message).not.toContain('ada@example.com');
  });

  it('a refused connection is a retryable "unreachable" failure', async () => {
    const smtp = await startFakeSmtp();
    const port = smtp.port;
    await smtp.close();
    const error = await mailerFor(port).send(mail()).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: ERR_UNREACHABLE, retryable: true });
  });
});

describe('classifyMailError', () => {
  it.each([
    [{ responseCode: 421 }, true], [{ responseCode: 450 }, true], [{ responseCode: 499 }, true],
    [{ responseCode: 500 }, false], [{ responseCode: 554 }, false],
    [{ code: 'ECONNECTION' }, true], [{ code: 'ETIMEDOUT' }, true], [{ code: 'ESOCKET' }, true],
    [{ code: 'EAUTH' }, false], [{ code: 'EENVELOPE' }, false],
    [{}, true], [new Error('who knows'), true],
  ])('%j -> retryable %s', (error, retryable) => {
    expect(classifyMailError(error).retryable).toBe(retryable);
  });
});
