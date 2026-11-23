import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';
import type { AppConfig } from '../config/env.schema.js';
import {
  ERR_AUTH,
  ERR_BUSY,
  ERR_OTHER,
  ERR_RECIPIENT,
  ERR_REFUSED,
  ERR_UNREACHABLE,
} from './mail.constants.js';

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  messageId: string;
}

/** What sends a mail. The real one uses nodemailer; tests pass a fake. */
export interface Mailer {
  send(mail: OutgoingMail): Promise<void>;
}

/** A failure of the mail server or connection, reduced to what the retry logic needs. `reason` is one of the fixed phrases. */
export class MailError extends Error {
  constructor(
    readonly reason: string,
    /** True if trying again later may work (a connection problem, SMTP 4xx). False for SMTP 5xx and other final answers. */
    readonly retryable: boolean,
  ) {
    super(reason);
    this.name = 'MailError';
  }
}

const CONNECTION_CODES = new Set(['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED', 'ECONNRESET', 'EDNS', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ETLS']);

/** Turns whatever nodemailer threw into a MailError with a fixed phrase. Nothing of the original message is kept (it can hold the address). */
export function classifyMailError(error: unknown): MailError {
  const e = error as { code?: unknown; responseCode?: unknown };
  const status = typeof e?.responseCode === 'number' ? e.responseCode : undefined;
  if (status !== undefined && status >= 400 && status < 500) return new MailError(ERR_BUSY, true);
  if (status !== undefined && status >= 500) return new MailError(ERR_REFUSED, false);
  if (e?.code === 'EAUTH') return new MailError(ERR_AUTH, false);
  if (e?.code === 'EENVELOPE') return new MailError(ERR_RECIPIENT, false);
  if (typeof e?.code === 'string' && CONNECTION_CODES.has(e.code)) return new MailError(ERR_UNREACHABLE, true);
  return new MailError(ERR_OTHER, true);
}

const logger = new Logger('Mailer');

@Injectable()
export class NodemailerMailer implements Mailer {
  private readonly transport: Transporter;
  private readonly from: string;
  private readonly replyTo: string | undefined;

  constructor(@Inject(ConfigService) config: ConfigService<AppConfig, true>) {
    const user = config.get('SMTP_USER', { infer: true });
    this.from = config.get('MAIL_FROM', { infer: true });
    this.replyTo = config.get('MAIL_REPLY_TO', { infer: true }) || undefined;
    this.transport = nodemailer.createTransport({
      host: config.get('SMTP_HOST', { infer: true }),
      port: config.get('SMTP_PORT', { infer: true }),
      secure: config.get('SMTP_SECURE', { infer: true }),
      ...(user ? { auth: { user, pass: config.get('SMTP_PASS', { infer: true }) } } : {}),
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }

  async send(mail: OutgoingMail): Promise<void> {
    try {
      await this.transport.sendMail({
        from: this.from,
        to: mail.to,
        ...(this.replyTo ? { replyTo: this.replyTo } : {}),
        subject: mail.subject,
        text: mail.text, // plain text only: no HTML part
        messageId: mail.messageId,
      });
    } catch (error) {
      const failure = classifyMailError(error);
      // Only the fixed phrase: the error's own text could contain the recipient.
      logger.warn(`SMTP send failed (${failure.reason})`);
      throw failure;
    }
  }
}
