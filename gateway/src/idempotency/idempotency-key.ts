import { createHash } from 'node:crypto';
import type { FieldProblem, TicketInput } from '../tickets/ticket.schema.js';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const KEY_MAX = 100;

const KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const KEY_PROBLEM = `must be 1 to ${KEY_MAX} characters: letters, digits, _ . : -`;

export type ParsedKey =
  | { ok: true; key: string | undefined }
  | { ok: false; problems: FieldProblem[] };

/**
 * Checks the Idempotency-Key header. No header means no key (the request behaves as it
 * always did). A header that is present but empty, too long or has other characters is
 * rejected, and the value is never echoed. A header sent twice reaches Node joined with
 * ", ", which the pattern rejects.
 */
export function parseIdempotencyKey(header: string | string[] | undefined): ParsedKey {
  if (header === undefined) return { ok: true, key: undefined };
  if (
    typeof header !== 'string' ||
    header.length < 1 ||
    header.length > KEY_MAX ||
    !KEY_PATTERN.test(header)
  ) {
    return { ok: false, problems: [{ field: IDEMPOTENCY_HEADER, problem: KEY_PROBLEM }] };
  }
  return { ok: true, key: header };
}

/**
 * A SHA-256 of the validated ticket (already trimmed by the schema), with the fields in a
 * fixed order, so the same ticket always gives the same fingerprint: whitespace around the
 * subject or body does not matter, and any change to a field does.
 */
export function fingerprintTicket(ticket: TicketInput): string {
  const canonical = JSON.stringify([ticket.subject, ticket.body, ticket.customer_id ?? null]);
  return createHash('sha256').update(canonical).digest('hex');
}
