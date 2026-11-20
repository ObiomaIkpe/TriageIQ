/**
 * Reads a Retry-After header: either whole seconds ("30") or an HTTP date
 * ("Wed, 21 Oct 2026 07:28:00 GMT"). Returns seconds from now, or undefined when the
 * header is missing, empty, negative, or not understood.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  if (text === '') return undefined;

  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isSafeInteger(seconds) ? seconds : undefined;
  }

  // HTTP dates always end in GMT. Requiring it keeps loose strings like "May 5" out.
  if (/GMT$/i.test(text)) {
    const at = Date.parse(text);
    if (Number.isNaN(at)) return undefined;
    return Math.max(0, Math.ceil((at - now) / 1000));
  }
  return undefined;
}
