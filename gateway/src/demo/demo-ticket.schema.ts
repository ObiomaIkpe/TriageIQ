import { createHash } from 'node:crypto';
import { z } from 'zod';
import { type FieldProblem, SUBJECT_MAX, BODY_MAX, problemsFrom } from '../tickets/ticket.schema.js';

/**
 * What a demo visitor may submit: a subject, a message, and the Turnstile token. NOT a name or an email: the customer of a demo
 * ticket is always the fixed "Demo Visitor" (DEMO_CUSTOMER_NAME), so nothing a visitor types about themselves is stored.
 * Unknown fields are rejected. Limits are those of the public form.
 */
export const demoTicketSchema = z.strictObject({
  subject: z.string().trim().min(1).max(SUBJECT_MAX),
  message: z.string().trim().min(1).max(BODY_MAX),
  turnstile_token: z.string().min(1).max(2048),
});

export type DemoTicketInput = z.infer<typeof demoTicketSchema>;
export type DemoParseResult = { ok: true; data: DemoTicketInput } | { ok: false; problems: FieldProblem[] };

export function parseDemoTicket(input: unknown): DemoParseResult {
  const result = demoTicketSchema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, problems: problemsFrom(result.error, input) };
}

/** The message only (a retry carries a new, or an already spent, Turnstile token and is still the same message). */
export const fingerprintDemoTicket = (ticket: DemoTicketInput): string =>
  createHash('sha256').update(JSON.stringify(['demo', ticket.subject, ticket.message])).digest('hex');
