/**
 * Refuses to start in production with a setting that is only fit for development.
 *
 * Runs at the end of validateEnv (so the gateway never gets as far as listening) when NODE_ENV is "production". Every message names the
 * SETTING and the rule, never a value. The Docker image sets NODE_ENV=production; the development compose file overrides it.
 */

/** Cloudflare's documented Turnstile TEST secret keys (always passes / always fails / token already spent). Never valid in production. */
export const TURNSTILE_TEST_SECRETS: readonly string[] = [
  '1x0000000000000000000000000000000AA',
  '2x0000000000000000000000000000000AA',
  '3x0000000000000000000000000000000AA',
];

const ZERO_HASH = '0'.repeat(64);

/**
 * True for a value copied from an .example file and never replaced: the examples all use "replace-with-..." or "REPLACE_ME...",
 * and the GATEWAY_CLIENTS example uses an all-zero hash for the client "example-submitter".
 */
export function isPlaceholder(value: string): boolean {
  return /replace[-_ ]?(me|with)/i.test(value) || value.includes(ZERO_HASH);
}

export interface GuardInput {
  /** The raw environment, to read what the user wrote (secrets). */
  raw: Record<string, unknown>;
  /** The validated settings. */
  values: Record<string, unknown>;
}

const text = (raw: Record<string, unknown>, name: string): string => {
  const value = raw[name];
  return typeof value === 'string' ? value.trim() : '';
};

/** The problems (setting name + rule) that make this configuration unfit for production. Empty outside production. */
export function productionProblems({ raw, values }: GuardInput): string[] {
  if (text(raw, 'NODE_ENV') !== 'production') return [];
  const problems: string[] = [];

  if (values.COOKIE_SECURE !== true) problems.push('COOKIE_SECURE must be true in production');

  const origins = Array.isArray(values.ALLOWED_ORIGINS) ? (values.ALLOWED_ORIGINS as string[]) : [];
  if (origins.some((origin) => origin.toLowerCase().startsWith('http://'))) {
    problems.push('ALLOWED_ORIGINS must contain only https:// origins in production');
  }

  const turnstile = text(raw, 'TURNSTILE_SECRET_KEY');
  if (TURNSTILE_TEST_SECRETS.includes(turnstile)) {
    problems.push("TURNSTILE_SECRET_KEY is one of Cloudflare's documented TEST secrets, which are never valid in production");
  }

  if (values.MAIL_ENABLED === true && text(raw, 'SMTP_HOST').toLowerCase() === 'mailpit') {
    problems.push('SMTP_HOST is mailpit (the local fake mail server) while MAIL_ENABLED is true; use a real provider');
  }

  // Secrets still holding the placeholder from an .example file.
  for (const name of ['TRIAGE_REVIEW_API_KEY', 'GATEWAY_DATABASE_URL', 'TURNSTILE_SECRET_KEY', 'SMTP_USER', 'SMTP_PASS']) {
    const value = text(raw, name);
    if (value !== '' && isPlaceholder(value)) problems.push(`${name} still has its .example placeholder value`);
  }
  const clients = Array.isArray(values.GATEWAY_CLIENTS) ? (values.GATEWAY_CLIENTS as { name?: string; key_sha256?: string }[]) : [];
  if (clients.some((client) => client.key_sha256 === ZERO_HASH || client.name === 'example-submitter')) {
    problems.push('GATEWAY_CLIENTS still has the .example placeholder client (create real ones with make-client-key)');
  }

  return problems;
}
