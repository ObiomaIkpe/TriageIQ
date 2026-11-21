import { randomInt } from 'node:crypto';

/**
 * The ticket reference (TKT-7K3M9Q) is made here, at accept time, so the gateway can answer the
 * customer with it straight away. The format is Python's, character for character (see
 * app/tickets/reference.py): no 0, O, 1, I or L, so a reference read aloud is not misread.
 * 31 letters/digits ^ 6 places = 887,503,681 references. Python keeps a unique constraint on it.
 *
 * Collision odds: for n tickets the chance that some pair shares a reference is about n^2 / (2 x 887.5 million):
 * 1 in 2,000 at 1,000 tickets, about 1 in 18 at 10,000. A collision is not silent: Python answers 409
 * (reference_conflict), the job goes to the dead letters, and the customer's reference never points at someone else's ticket.
 * Python's own generator retries on a collision; a reference chosen here cannot, because the customer has it already.
 */
export const REFERENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const REFERENCE_PREFIX = 'TKT-';
export const REFERENCE_LENGTH = 6;
export const REFERENCE_PATTERN = new RegExp(`^${REFERENCE_PREFIX}[${REFERENCE_ALPHABET}]{${REFERENCE_LENGTH}}$`);

/** A fresh reference. Uses crypto.randomInt, which is unbiased (no modulo skew). */
export function newReference(): string {
  let out = REFERENCE_PREFIX;
  for (let i = 0; i < REFERENCE_LENGTH; i += 1) out += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  return out;
}
