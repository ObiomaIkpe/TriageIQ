import { api } from './client.js';

export const LIMITS = { name: 100, email: 254, subject: 200, message: 5000 } as const; // the gateway's limits

export interface PublicTicketBody {
  name: string;
  email: string;
  subject: string;
  message: string;
  turnstile_token: string;
  /** The honeypot. Real people never see it, so it is empty. */
  website: string;
}

/** The only thing the customer gets back: a reference and a thank-you. (The gateway never returns anything about processing.) */
export interface PublicTicketAnswer {
  reference: string;
  message: string;
}

/** Sends the form. The Idempotency-Key makes a retry of the same message create one ticket. No login, no cookie needed. */
export function submitPublicTicket(body: PublicTicketBody, idempotencyKey: string): Promise<PublicTicketAnswer> {
  return api<PublicTicketAnswer>('/public/tickets', {
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': idempotencyKey },
    sessionEndsOn401: false,
  });
}
