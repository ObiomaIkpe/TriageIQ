import { z } from 'zod';
import type { FieldProblem } from '../tickets/ticket.schema.js';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_OFFSET = 1_000_000;

/** Digits only: "5" is fine, "5.5", "-1", "1e2", " 5" and "abc" are not. */
function whole(min: number, max: number, fallback: number) {
  return z
    .string()
    .regex(/^\d{1,9}$/)
    .transform(Number)
    .pipe(z.number().int().min(min).max(max))
    .optional()
    .transform((value) => value ?? fallback);
}

const querySchema = z.object({
  limit: whole(1, MAX_LIMIT, DEFAULT_LIMIT),
  offset: whole(0, MAX_OFFSET, 0),
});

export type ParsedPage =
  | { ok: true; limit: number; offset: number }
  | { ok: false; problems: FieldProblem[] };

const HINTS: Record<string, string> = {
  limit: `must be a whole number from 1 to ${MAX_LIMIT}`,
  offset: `must be a whole number from 0 to ${MAX_OFFSET}`,
};

/** Checks ?limit and ?offset. Problems name the field and a fixed hint, never the value. */
export function parsePage(query: Record<string, unknown>): ParsedPage {
  const result = querySchema.safeParse({ limit: query.limit, offset: query.offset });
  if (result.success) return { ok: true, ...result.data };
  const fields = new Set(result.error.issues.map((issue) => String(issue.path[0])));
  return {
    ok: false,
    problems: [...fields].map((field) => ({ field, problem: HINTS[field] ?? 'is invalid' })),
  };
}
