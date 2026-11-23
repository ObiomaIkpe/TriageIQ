import { z } from 'zod';
import type { FieldProblem } from '../tickets/ticket.schema.js';

/** Python's TicketStatus values. */
export const TICKET_STATUSES = ['triaged', 'pending_review', 'approved', 'edited', 'rejected'] as const;
export const LIMIT_MAX = 200;

/** The alphabet Python's new_reference() draws from: no 0, O, 1, I or L. */
export const REFERENCE_PATTERN = /^TKT-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

export const isUuid = (value: string) => z.uuid().safeParse(value).success;
export const isReference = (value: string) => REFERENCE_PATTERN.test(value);

/** "<created_at ISO>|<ticket id>": the keyset cursor Python gives back as the last ticket's fields (see app/api/tickets.py). */
export const CURSOR_PATTERN = /^\d{4}-\d{2}-\d{2}T[0-9:.]{8,16}(Z|[+-]\d{2}:\d{2})\|[0-9a-fA-F-]{36}$/;

const listQuery = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  cursor: z.string().max(100).regex(CURSOR_PATTERN).optional(),
  limit: z
    .string()
    .regex(/^\d{1,4}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(LIMIT_MAX))
    .optional(),
});

export type ListQueryResult =
  | { ok: true; params: Record<string, string> }
  | { ok: false; problems: FieldProblem[] };

const QUERY_HINTS: Record<string, string> = {
  status: `must be one of ${TICKET_STATUSES.join(', ')}`,
  limit: `must be a whole number from 1 to ${LIMIT_MAX}`,
  cursor: 'must be the created_at and ticket_id of the last ticket you have, joined by |',
};

/**
 * Checks the query of GET /tickets. Only `status`, `limit` and `cursor` (what Python supports) are
 * read; every other parameter is dropped, not forwarded. Problems name the field and a fixed
 * hint, never the value. A parameter left out stays out, so Python's defaults apply.
 */
export function parseListQuery(query: Record<string, unknown>): ListQueryResult {
  const result = listQuery.safeParse({ status: query.status, limit: query.limit, cursor: query.cursor });
  if (!result.success) {
    const fields = new Set(result.error.issues.map((issue) => String(issue.path[0])));
    return {
      ok: false,
      problems: [...fields].map((field) => ({ field, problem: QUERY_HINTS[field] ?? 'is invalid' })),
    };
  }
  const params: Record<string, string> = {};
  if (typeof query.status === 'string') params.status = query.status;
  if (typeof query.limit === 'string') params.limit = String(result.data.limit);
  if (typeof query.cursor === 'string') params.cursor = query.cursor;
  return { ok: true, params };
}

/**
 * Python's ReviewDecision: an action, an edited reply (required, and not blank, for "edit") and
 * an optional note. Unknown fields are rejected. null is accepted where Python accepts it.
 */
const reviewDecision = z.strictObject({
  action: z.enum(['approve', 'edit', 'reject']),
  edited_reply: z.string().nullish(),
  note: z.string().nullish(),
});

export type ReviewDecisionInput = { action: 'approve' | 'edit' | 'reject'; edited_reply?: string; note?: string };

export type ReviewParse =
  | { ok: true; data: ReviewDecisionInput }
  | { ok: false; problems: FieldProblem[] };

export function parseReviewDecision(input: unknown): ReviewParse {
  const result = reviewDecision.safeParse(input);
  if (!result.success) {
    const problems: FieldProblem[] = [];
    for (const issue of result.error.issues) {
      const field = issue.path.map(String).join('.');
      if (issue.code === 'unrecognized_keys') {
        for (const key of issue.keys) problems.push({ field: key.slice(0, 50), problem: 'unknown field' });
      } else if (field === '') {
        problems.push({ field: '(body)', problem: 'must be a JSON object' });
      } else if (field === 'action') {
        problems.push({ field, problem: 'must be one of approve, edit, reject' });
      } else {
        problems.push({ field, problem: 'must be text' });
      }
    }
    return { ok: false, problems };
  }
  const { action, edited_reply: editedReply, note } = result.data;
  if (action === 'edit' && (editedReply ?? '').trim() === '') {
    return { ok: false, problems: [{ field: 'edited_reply', problem: 'is required and must not be blank for action "edit"' }] };
  }
  return {
    ok: true,
    data: {
      action,
      ...(editedReply != null ? { edited_reply: editedReply } : {}),
      ...(note != null ? { note } : {}),
    },
  };
}

/** Python's reviewed_by on a ticket: who decided it, or null (not reviewed, or reviewed before it was recorded). */
export const reviewedBySchema = z.object({ id: z.string().min(1), name: z.string().min(1) });

/**
 * A ticket as Python returns it, checked loosely: every field is passed through untouched, only
 * reviewed_by is checked, and it may be missing (an older Python) or null.
 */
export const ticketRecordSchema = z.looseObject({ reviewed_by: reviewedBySchema.nullish() });

/** True if `body` is a ticket record or a list of them whose reviewed_by (if any) is well formed. */
export function isTicketPayload(body: unknown): boolean {
  return Array.isArray(body)
    ? body.every((item) => ticketRecordSchema.safeParse(item).success)
    : ticketRecordSchema.safeParse(body).success;
}

/** GET /tickets/counts: every ticket status mapped to a non-negative whole number, and nothing else. */
export function isCountsPayload(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const entries = Object.entries(body);
  return (
    entries.length === TICKET_STATUSES.length &&
    TICKET_STATUSES.every((status) => Number.isInteger((body as Record<string, unknown>)[status]) && (body as Record<string, number>)[status] >= 0)
  );
}
