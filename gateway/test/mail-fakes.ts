import net from 'node:net';
import type { DeliveryRow } from '../src/mail/reply-delivery.repository.js';
import type { DeliveryStatus } from '../src/mail/mail.constants.js';
import { MailError, type Mailer, type OutgoingMail } from '../src/mail/mailer.js';
import type { RecipientCounter } from '../src/mail/recipient-counter.js';

/** A stand-in for the BullMQ "reply-email" queue. Like BullMQ, adding a job whose id already exists is a silent no-op. */
export class FakeReplyQueue {
  jobs = new Map<string, { name: string; data: { ticket_id: string; reference: string }; opts: Record<string, unknown> }>();
  /** Every add() call, including ignored ones. */
  adds: { name: string; jobId: string }[] = [];
  schedulers: { id: string; every: number; name: string }[] = [];
  addError: Error | undefined;
  removeError: Error | undefined;

  waitUntilReady() {
    return Promise.resolve();
  }
  add(name: string, data: { ticket_id: string; reference: string }, opts: { jobId: string }) {
    if (this.addError) return Promise.reject(this.addError);
    this.adds.push({ name, jobId: opts.jobId });
    if (!this.jobs.has(opts.jobId)) this.jobs.set(opts.jobId, { name, data, opts });
    return Promise.resolve({ id: opts.jobId });
  }
  getJob(id: string) {
    const job = this.jobs.get(id);
    return Promise.resolve(
      job && {
        id,
        remove: () => (this.removeError ? Promise.reject(this.removeError) : (this.jobs.delete(id), Promise.resolve())),
      },
    );
  }
  upsertJobScheduler(id: string, repeat: { every?: number }, template: { name?: string }) {
    this.schedulers.push({ id, every: repeat.every ?? 0, name: template.name ?? '' });
    return Promise.resolve({});
  }
}

/** The delivery table in memory, with the same rules as the SQL (every update names the status it expects). */
export class MemoryDeliveries {
  rows = new Map<string, DeliveryRow>();
  /** Make every call throw, like a database that is down. */
  down = false;
  private check() {
    if (this.down) throw new Error('database down');
  }
  async insert(ticketId: string, reference: string, status: 'queued' | 'skipped_no_email') {
    this.check();
    if (this.rows.has(ticketId)) return false;
    this.rows.set(ticketId, { ticket_id: ticketId, reference, status, attempts: 0, last_error: null, queued_at: new Date(), sent_at: null });
    return true;
  }
  async get(ticketId: string) {
    this.check();
    return this.rows.get(ticketId);
  }
  private ifStatus(ticketId: string, status: DeliveryStatus) {
    const row = this.rows.get(ticketId);
    return row && row.status === status ? row : undefined;
  }
  async startAttempt(ticketId: string) {
    const row = this.ifStatus(ticketId, 'queued');
    if (row) row.attempts += 1;
    return row?.attempts;
  }
  async markSent(ticketId: string) {
    const row = this.ifStatus(ticketId, 'queued');
    if (row) Object.assign(row, { status: 'sent', sent_at: new Date(), last_error: null });
  }
  async markFailed(ticketId: string, error: string) {
    const row = this.ifStatus(ticketId, 'queued');
    if (row) Object.assign(row, { status: 'failed', last_error: error });
  }
  async markSkippedNoEmail(ticketId: string) {
    const row = this.ifStatus(ticketId, 'queued');
    if (row) Object.assign(row, { status: 'skipped_no_email', last_error: null });
  }
  async noteError(ticketId: string, error: string) {
    const row = this.ifStatus(ticketId, 'queued');
    if (row) row.last_error = error;
  }
  async resetFailed(ticketId: string) {
    const row = this.ifStatus(ticketId, 'failed');
    if (!row) return false;
    Object.assign(row, { status: 'queued', attempts: 0, last_error: null, sent_at: null, queued_at: new Date() });
    return true;
  }
  async markFailedFromQueued(ticketId: string) {
    const row = this.ifStatus(ticketId, 'queued');
    if (row && row.attempts === 0) Object.assign(row, { status: 'failed', last_error: 'could not queue the retry' });
  }
  async deleteUntried(ticketId: string) {
    const row = this.ifStatus(ticketId, 'queued');
    if (row && row.attempts === 0) this.rows.delete(ticketId);
  }
  async existing(ids: string[]) {
    return new Set(ids.filter((id) => this.rows.has(id)));
  }
  async staleQueued(olderThanMs: number) {
    const cutoff = Date.now() - olderThanMs;
    return [...this.rows.values()].filter((r) => r.status === 'queued' && r.queued_at.getTime() < cutoff).map((r) => ({ ticket_id: r.ticket_id, reference: r.reference }));
  }
}

/** A mailer that records what it was asked to send, and fails on demand. */
export class FakeMailer implements Mailer {
  sent: OutgoingMail[] = [];
  /** Consumed one per send(): a MailError makes that send fail. */
  failures: (MailError | undefined)[] = [];
  async send(mail: OutgoingMail) {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push(mail);
  }
}

/** The per-recipient counter in memory. Keeps the keys it was given, so a test can check they hold no address. */
export class MemoryRecipientCounter implements RecipientCounter {
  counts = new Map<string, number>();
  async reserve(key: string, max: number) {
    const next = (this.counts.get(key) ?? 0) + 1;
    if (next > max) return false;
    this.counts.set(key, next);
    return true;
  }
  async release(key: string) {
    const n = this.counts.get(key) ?? 0;
    if (n > 0) this.counts.set(key, n - 1);
  }
}

/**
 * A tiny SMTP server on a local port: enough of the protocol (EHLO, MAIL, RCPT, DATA, QUIT) for nodemailer to deliver to,
 * recording every message's envelope and raw text. `script` can answer a command with a chosen reply (e.g. '451 try later'
 * or '550 no such user') to test how failures are classified.
 */
export async function startFakeSmtp(script: { rcpt?: () => string | undefined; data?: () => string | undefined } = {}) {
  const messages: { from: string; to: string[]; raw: string }[] = [];
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    let current = { from: '', to: [] as string[], raw: '' };
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          current.raw = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          const refusal = script.data?.();
          if (refusal) socket.write(`${refusal}\r\n`);
          else {
            messages.push(current);
            socket.write('250 OK queued\r\n');
          }
          current = { from: '', to: [], raw: '' };
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const command = line.slice(0, 4).toUpperCase();
        if (command === 'EHLO' || command === 'HELO') socket.write('250 fake\r\n');
        else if (command === 'MAIL') {
          current.from = line;
          socket.write('250 OK\r\n');
        } else if (command === 'RCPT') {
          const refusal = script.rcpt?.();
          if (refusal) socket.write(`${refusal}\r\n`);
          else {
            current.to.push(line);
            socket.write('250 OK\r\n');
          }
        } else if (command === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (command === 'QUIT') {
          socket.write('221 bye\r\n');
          socket.end();
        } else if (command === 'RSET' || command === 'NOOP') socket.write('250 OK\r\n');
        else socket.write('502 not implemented\r\n');
      }
    });
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  return { port, messages, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
