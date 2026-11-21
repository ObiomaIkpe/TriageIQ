import { z } from 'zod';

export const EMAIL_FIELD_MAX = 254;
export const PASSWORD_FIELD_MAX = 128;

/** The body of POST /auth/login. Unknown fields are refused. */
export const loginSchema = z.strictObject({
  email: z.string().min(1).max(EMAIL_FIELD_MAX),
  password: z.string().min(1).max(PASSWORD_FIELD_MAX),
});

export type LoginInput = z.infer<typeof loginSchema>;

/** True if the body has the right shape. The reason is never reported: it could echo what was typed. */
export function parseLogin(body: unknown): { ok: true; data: LoginInput } | { ok: false } {
  const result = loginSchema.safeParse(body);
  return result.success ? { ok: true, data: result.data } : { ok: false };
}
