import { ROLES, type RegisteredClient } from '../auth/auth.types.js';
import { HASH_PATTERN, NAME_PATTERN } from '../auth/client-key.js';
import { PUBLIC_FORM_CLIENT } from '../public-tickets/public.constants.js';

export type ParsedClients =
  | { ok: true; clients: RegisteredClient[] }
  | { ok: false; problems: string[] };

const FIELDS = new Set(['name', 'role', 'key_sha256']);

/**
 * Checks the GATEWAY_CLIENTS setting: a JSON array of { name, role, key_sha256 }.
 * Every problem is a fixed phrase plus, at most, the position of the entry. It never contains
 * a name, a hash or any other part of the value, so nothing secret can reach a log.
 */
export function parseClients(raw: string): ParsedClients {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, problems: ['is not valid JSON'] };
  }
  if (!Array.isArray(value)) return { ok: false, problems: ['must be a JSON array'] };
  if (value.length === 0) return { ok: false, problems: ['needs at least one client'] };

  const problems: string[] = [];
  const clients: RegisteredClient[] = [];
  const seen = new Map<string, number>();

  value.forEach((entry: unknown, index) => {
    const at = `entry ${index + 1}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      problems.push(`${at} must be an object`);
      return;
    }
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some((key) => !FIELDS.has(key))) {
      problems.push(`${at} has a field other than name, role and key_sha256`);
    }
    const { name, role, key_sha256: hash } = record;
    let valid = true;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      problems.push(`${at}: name must be 1 to 40 characters of a-z, 0-9 and -`);
      valid = false;
    }
    if (name === PUBLIC_FORM_CLIENT) {
      // Reserved: public-form tickets are owned by this built-in client, so a real client with the
      // same name would share its ownership, rate-limit and idempotency namespace.
      problems.push(`${at}: the name "${PUBLIC_FORM_CLIENT}" is reserved for the public form`);
      valid = false;
    }
    if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
      problems.push(`${at}: role must be "submitter" or "reviewer"`);
      valid = false;
    }
    if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
      problems.push(`${at}: key_sha256 must be 64 lowercase hex characters`);
      valid = false;
    }
    if (valid) {
      const first = seen.get(name as string);
      if (first !== undefined) {
        problems.push(`${at} repeats the name of entry ${first}`);
        valid = false;
      } else {
        seen.set(name as string, index + 1);
      }
    }
    if (valid) clients.push({ name: name as string, role: role as RegisteredClient['role'], key_sha256: hash as string });
  });

  return problems.length > 0 ? { ok: false, problems } : { ok: true, clients };
}
