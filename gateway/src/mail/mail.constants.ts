/** The BullMQ queue for "email this approved reply". It also carries the repeating sweep job. */
export const REPLY_QUEUE = 'reply-email';
export const SEND_JOB = 'send';
export const SWEEP_JOB = 'sweep';
export const SWEEP_SCHEDULER_ID = 'reply-sweep';

export const MAILER = Symbol('MAILER');
export const RECIPIENT_COUNTER = Symbol('RECIPIENT_COUNTER');

/** How often the sweep looks for approvals whose email was never queued. */
export const SWEEP_EVERY_MS = 5 * 60 * 1000;
/** The sweep only looks at tickets reviewed within this long. */
export const SWEEP_WINDOW_DAYS = 7;
/** A delivery row still "queued" this long after it was made has probably lost its job: the sweep re-adds it (adding is idempotent). */
export const STALE_QUEUED_MS = 10 * 60 * 1000;

export type DeliveryStatus = 'queued' | 'sent' | 'failed' | 'skipped_no_email';

/**
 * The only error texts ever stored or shown. Fixed phrases: no address, no body, nothing the mail server said
 * (a server's own message can echo the recipient).
 */
export const ERR_UNREACHABLE = 'mail server unreachable';
export const ERR_BUSY = 'mail server busy, try again later';
export const ERR_REFUSED = 'mail server refused the message';
export const ERR_AUTH = 'mail server rejected our login';
export const ERR_RECIPIENT = 'recipient address refused';
export const ERR_TRIAGE_DOWN = 'could not read the ticket';
export const ERR_NOT_APPROVED = 'ticket is not approved or has no reply';
export const ERR_LIMIT = 'recipient daily limit';
export const ERR_DEMO = 'demo tickets are never emailed';
export const ERR_OTHER = 'mail error';
