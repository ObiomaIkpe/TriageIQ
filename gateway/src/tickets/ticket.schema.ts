import { z } from 'zod';

export const SUBJECT_MAX = 200;
export const BODY_MAX = 5000;
export const CUSTOMER_ID_MAX = 100;

/**
 * The ticket a client may send. Field names match the Python TicketIn model.
 * Unknown fields are rejected. subject and body are trimmed before the length check.
 */
export const ticketSchema = z.strictObject({
  subject: z.string().trim().min(1).max(SUBJECT_MAX),
  body: z.string().trim().min(1).max(BODY_MAX),
  customer_id: z.string().max(CUSTOMER_ID_MAX).optional(),
});

export type TicketInput = z.infer<typeof ticketSchema>;

export interface FieldProblem {
  field: string;
  problem: string;
}

export type ParseResult =
  | { ok: true; data: TicketInput }
  | { ok: false; problems: FieldProblem[] };

/** Field names the client chose are echoed back, but cut short. Values never are. */
const MAX_ECHOED_NAME = 50;

function isMissing(input: unknown, field: string): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    !Array.isArray(input) &&
    (input as Record<string, unknown>)[field] === undefined
  );
}

/**
 * Checks a request body. Every message is built from the field name and a fixed
 * phrase, never from the submitted value, so nothing the client sent is echoed.
 */
export function parseTicket(input: unknown): ParseResult {
  const result = ticketSchema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };

  const problems: FieldProblem[] = [];
  for (const issue of result.error.issues) {
    const field = issue.path.map(String).join('.');
    switch (issue.code) {
      case 'unrecognized_keys':
        for (const key of issue.keys) {
          problems.push({ field: key.slice(0, MAX_ECHOED_NAME), problem: 'unknown field' });
        }
        break;
      case 'invalid_type':
        if (field === '') {
          problems.push({ field: '(body)', problem: 'must be a JSON object' });
        } else if (isMissing(input, field)) {
          problems.push({ field, problem: 'is required' });
        } else {
          problems.push({ field, problem: `must be a ${issue.expected}` });
        }
        break;
      case 'too_small':
        problems.push({ field, problem: 'must not be empty' });
        break;
      case 'too_big':
        problems.push({ field, problem: `must be at most ${String(issue.maximum)} characters` });
        break;
      default:
        problems.push({ field: field || '(body)', problem: 'is invalid' });
    }
  }
  return { ok: false, problems };
}
