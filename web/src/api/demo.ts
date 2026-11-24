import { api } from './client.js';

/** What a demo visitor may type: a subject and a message. (The customer of a demo ticket is always the fixed "Demo Visitor".) */
export const DEMO_LIMITS = { subject: 200, message: 5000 } as const; // the gateway's limits

export interface DemoTicketBody {
  subject: string;
  message: string;
  turnstile_token: string;
}

export interface DemoTicketAnswer {
  reference: string;
  message: string;
}

/** Sends a test ticket. A REAL triage run (real model calls) that appears in the demo queue as a demo ticket. */
export function submitDemoTicket(body: DemoTicketBody, idempotencyKey: string): Promise<DemoTicketAnswer> {
  return api<DemoTicketAnswer>('/demo/tickets', { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } });
}
