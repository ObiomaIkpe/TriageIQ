/** The pieces of an outgoing reply that are decided by rules, kept pure so they can be tested without a mail server. */

export const SUBJECT_MAX = 120;

/**
 * The customer-supplied subject, made safe for a header: every control character (CR, LF, tab, NUL ...) and Unicode line
 * or paragraph separator becomes a space, runs of spaces collapse, and the length is capped. Without this a subject
 * such as "Hi\r\nBcc: someone@else" could add headers to the mail (header injection).
 */
export function cleanSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = subject.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > SUBJECT_MAX ? `${flat.slice(0, SUBJECT_MAX - 1).trimEnd()}…` : flat;
}

export const replySubject = (subject: string, reference: string): string => `Re: ${cleanSubject(subject)} [${reference}]`;

/** The deterministic Message-ID, so any duplicate delivery is recognisable (and a mail server may drop it). */
export const messageIdFor = (ticketId: string): string => `<${ticketId}@triageiq>`;

/** Plain text only: the reply, then a short footer with the reference. */
export function replyBody(finalReply: string, reference: string): string {
  return `${finalReply.trimEnd()}\n\n--\nReference: ${reference}\n`;
}

/** An address that is safe to hand to a mail library: one plain address, no separators, quotes or line breaks. */
export function isPlainAddress(address: string): boolean {
  return address.length <= 254 && /^[^\s<>@,;"'()\\]+@[^\s<>@,;"'()\\]+\.[^\s<>@,;"'()\\]+$/.test(address);
}
