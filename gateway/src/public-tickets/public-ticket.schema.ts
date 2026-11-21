import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BODY_MAX, type FieldProblem, SUBJECT_MAX, problemsFrom } from '../tickets/ticket.schema.js';

export const NAME_MAX = 100;
export const EMAIL_MAX = 254;
export const TOKEN_MAX = 2048;

/**
 * What the public form may send. Unknown fields are rejected. Text is trimmed before the length check;
 * subject and message have exactly the limits of the API ticket (subject, body). The email is stored
 * trimmed and lower-cased. `website` is the honeypot: real people never see it, so it is empty.
 */
export const publicTicketSchema = z.strictObject({
  name: z.string().trim().min(1).max(NAME_MAX),
  email: z.string().trim().toLowerCase().min(1).max(EMAIL_MAX).pipe(z.email()),
  subject: z.string().trim().min(1).max(SUBJECT_MAX),
  message: z.string().trim().min(1).max(BODY_MAX),
  turnstile_token: z.string().min(1).max(TOKEN_MAX),
  website: z.string().optional(),
});

export type PublicTicketInput = z.infer<typeof publicTicketSchema>;

export type PublicParseResult = { ok: true; data: PublicTicketInput } | { ok: false; problems: FieldProblem[] };

export function parsePublicTicket(input: unknown): PublicParseResult {
  const result = publicTicketSchema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, problems: problemsFrom(result.error, input) };
}

/**
 * The idempotency fingerprint: the content of the message only. The Turnstile token and the honeypot are
 * left out on purpose: a retry of the same message carries a new (or already spent) token and must still
 * count as the same message, not a conflict.
 */
export function fingerprintPublicTicket(ticket: PublicTicketInput): string {
  const canonical = JSON.stringify([ticket.name, ticket.email, ticket.subject, ticket.message]);
  return createHash('sha256').update(canonical).digest('hex');
}
