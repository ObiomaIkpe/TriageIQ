import { replyBody, replySubject } from '../mail/reply-email.js';

/** What a demo visitor is shown instead of an email: exactly the text a real send would use (same functions as the mail worker). */
export interface EmailPreview {
  to: string | null;
  subject: string;
  body: string;
}

/**
 * The preview for a decided DEMO ticket, or undefined if there is nothing to preview (not approved or edited, no reply text). It is
 * built with the SAME replySubject and replyBody the real mail worker calls, so what the visitor sees is what would have been sent.
 */
export function demoEmailPreview(ticket: unknown): EmailPreview | undefined {
  const t = ticket as { is_demo?: unknown; status?: unknown; subject?: unknown; reference?: unknown; final_reply?: unknown; customer_email?: unknown } | null;
  if (!t || t.is_demo !== true) return undefined;
  if (t.status !== 'approved' && t.status !== 'edited') return undefined;
  if (typeof t.subject !== 'string' || typeof t.reference !== 'string' || typeof t.final_reply !== 'string' || t.final_reply.trim() === '') return undefined;
  return {
    to: typeof t.customer_email === 'string' ? t.customer_email : null,
    subject: replySubject(t.subject, t.reference),
    body: replyBody(t.final_reply, t.reference),
  };
}
