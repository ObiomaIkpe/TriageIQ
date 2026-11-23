import { z } from 'zod';
import type { RegisteredClient } from '../auth/auth.types.js';
import { parseClients } from './clients.js';

/** The validated settings the gateway needs to run. */
export interface AppConfig {
  PORT: number;
  REDIS_URL: string;
  TRIAGE_SERVICE_URL: string;
  WORKER_CONCURRENCY: number;
  TRIAGE_TIMEOUT_MS: number;
  /** The API clients allowed to call the gateway. Only key hashes, never keys. */
  GATEWAY_CLIENTS: RegisteredClient[];
  RATE_LIMIT_PER_MINUTE: number;
  /** Sent to the Python service as X-API-Key on review calls. The same value as its REVIEW_API_KEY. */
  TRIAGE_REVIEW_API_KEY: string;
  /** The gateway's own Postgres database (reviewer accounts). Contains a password: never logged. */
  GATEWAY_DATABASE_URL: string;
  /** A session ends after this many minutes without use. */
  SESSION_IDLE_MINUTES: number;
  /** A session ends this many hours after login, however busy it is. */
  SESSION_ABSOLUTE_HOURS: number;
  /** Whether the session cookie carries the Secure attribute. True unless set otherwise (fail safe). */
  COOKIE_SECURE: boolean;
  /** Origins allowed to send cookie-authenticated writes (exact match). Empty: none. */
  ALLOWED_ORIGINS: string[];
  LOGIN_MAX_FAILURES_PER_IP: number;
  LOGIN_MAX_FAILURES_PER_EMAIL: number;
  LOGIN_WINDOW_MINUTES: number;
  /** Trust X-Forwarded-For (Express "trust proxy") to find the client IP. Only behind a proxy you control. */
  TRUST_PROXY: boolean;
  /** POST /public/tickets (no login, no key). Off by default: the route answers 404. */
  PUBLIC_FORM_ENABLED: boolean;
  /** Cloudflare Turnstile secret. Required when the form is enabled. Never logged. */
  TURNSTILE_SECRET_KEY: string;
  TURNSTILE_VERIFY_URL: string;
  /** Hostnames Turnstile may report (the site the widget ran on). Empty: not checked. */
  TURNSTILE_EXPECTED_HOSTNAMES: string[];
  /** The widget action Turnstile must report (e.g. public_ticket). Empty: not checked. */
  TURNSTILE_EXPECTED_ACTION: string;
  /** Public form submissions allowed per client IP per hour (a spam submission counts too). */
  PUBLIC_MAX_PER_IP_PER_HOUR: number;
  /** Accepted public tickets per UTC day, across everyone: the cap on what the form can cost. */
  PUBLIC_DAILY_CAP: number;
  /** Send approved replies to customers by email. Off by default; nothing is ever emailed without a reviewer's approval. */
  MAIL_ENABLED: boolean;
  SMTP_HOST: string;
  SMTP_PORT: number;
  /** TLS from the first byte (port 465). False: plain, or STARTTLS if the server offers it. */
  SMTP_SECURE: boolean;
  /** Both or neither. Never logged. */
  SMTP_USER: string;
  SMTP_PASS: string;
  /** "Name <address>" or just an address. */
  MAIL_FROM: string;
  MAIL_REPLY_TO: string;
  /** Reply emails one recipient may receive per UTC day (a guard against using us to mail someone repeatedly). */
  MAIL_MAX_PER_RECIPIENT_PER_DAY: number;
}

interface Setting {
  /** Checks one value. Exactly one of `schema` and `parse` is set. */
  schema?: z.ZodType;
  /** For a setting whose problems need more than one sentence (the client registry). */
  parse?: (value: string) => { ok: true; data: unknown } | { ok: false; problems: string[] };
  /** A fixed phrase shown when the value is invalid. It never contains the value. */
  hint: string;
  /** Present only on optional settings: used when the setting is missing or blank. */
  default?: unknown;
}

/** "true" or "false" in any capitalisation. Anything else is refused, so a typo never turns a safety setting off. */
const booleanSetting = z
  .string()
  .transform((value) => value.toLowerCase())
  .pipe(z.enum(['true', 'false']))
  .transform((value) => value === 'true');

type OriginsResult = { ok: true; origins: string[] } | { ok: false; problems: string[] };

/** ALLOWED_ORIGINS: comma-separated origins such as http://localhost:5173 (no path), normalized and de-duplicated. */
function parseOrigins(value: string): OriginsResult {
  const problems: string[] = [];
  const origins: string[] = [];
  value.split(',').forEach((raw, index) => {
    const entry = raw.trim();
    const at = `entry ${index + 1}`;
    if (entry === '') {
      problems.push(`${at} is empty`);
      return;
    }
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      problems.push(`${at} is not a URL`);
      return;
    }
    const plain = url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '' && url.password === '';
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !plain) {
      problems.push(`${at} must be an origin such as https://reviews.example.com (http or https, no path)`);
      return;
    }
    if (!origins.includes(url.origin)) origins.push(url.origin);
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, origins };
}

/** MAIL_FROM: `Name <a@b.c>` or `a@b.c`. No control characters (a header must never be able to carry a line break). */
const MAIL_ADDRESS = /^(?:[^<>\r\n"]{1,100}\s)?<?[^\s<>@,;"\r\n]+@[^\s<>@,;"\r\n]+\.[^\s<>@,;"\r\n]+>?$/;
const mailAddressSetting = z.string().max(200).regex(MAIL_ADDRESS);

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** TURNSTILE_EXPECTED_HOSTNAMES: comma-separated hostnames (no scheme, port or path), lower-cased. */
function parseHostnames(value: string): { ok: true; hostnames: string[] } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const hostnames: string[] = [];
  value.split(',').forEach((raw, index) => {
    const entry = raw.trim().toLowerCase();
    if (!HOSTNAME.test(entry)) problems.push(`entry ${index + 1} must be a hostname such as example.com (no scheme, port or path)`);
    else if (!hostnames.includes(entry)) hostnames.push(entry);
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, hostnames };
}

/** One entry per setting: how to check it, and a fixed hint shown when it is invalid. */
const SETTINGS: Record<keyof AppConfig, Setting> = {
  PORT: {
    schema: z.coerce.number().int().min(1).max(65535),
    hint: 'must be a whole number from 1 to 65535',
  },
  REDIS_URL: {
    schema: z.url({ protocol: /^rediss?$/, hostname: /^.+$/ }),
    hint: 'must be a redis:// or rediss:// URL',
  },
  TRIAGE_SERVICE_URL: {
    schema: z.url({ protocol: /^https?$/ }),
    hint: 'must be an http:// or https:// URL',
  },
  WORKER_CONCURRENCY: {
    schema: z.coerce.number().int().min(1).max(10),
    hint: 'must be a whole number from 1 to 10',
    default: 2,
  },
  TRIAGE_TIMEOUT_MS: {
    schema: z.coerce.number().int().min(1000).max(600000),
    hint: 'must be a whole number of milliseconds from 1000 to 600000',
    default: 120000,
  },
  GATEWAY_CLIENTS: {
    parse: (value) => {
      const result = parseClients(value);
      return result.ok ? { ok: true, data: result.clients } : result;
    },
    hint: '',
  },
  RATE_LIMIT_PER_MINUTE: {
    schema: z.coerce.number().int().min(1).max(10000),
    hint: 'must be a whole number from 1 to 10000',
    default: 60,
  },
  TRIAGE_REVIEW_API_KEY: {
    schema: z.string().min(1),
    hint: 'must not be empty',
  },
  GATEWAY_DATABASE_URL: {
    schema: z.url({ protocol: /^postgres(ql)?$/, hostname: /^.+$/ }),
    hint: 'must be a postgresql:// URL',
  },
  SESSION_IDLE_MINUTES: {
    schema: z.coerce.number().int().min(1).max(1440),
    hint: 'must be a whole number of minutes from 1 to 1440',
    default: 60,
  },
  SESSION_ABSOLUTE_HOURS: {
    schema: z.coerce.number().int().min(1).max(168),
    hint: 'must be a whole number of hours from 1 to 168',
    default: 8,
  },
  COOKIE_SECURE: {
    schema: booleanSetting,
    hint: 'must be true or false',
    default: true,
  },
  ALLOWED_ORIGINS: {
    parse: (value) => {
      const result = parseOrigins(value);
      return result.ok ? { ok: true, data: result.origins } : result;
    },
    hint: '',
    default: [],
  },
  LOGIN_MAX_FAILURES_PER_IP: {
    schema: z.coerce.number().int().min(1).max(100000),
    hint: 'must be a whole number from 1 to 100000',
    default: 20,
  },
  LOGIN_MAX_FAILURES_PER_EMAIL: {
    schema: z.coerce.number().int().min(1).max(1000),
    hint: 'must be a whole number from 1 to 1000',
    default: 5,
  },
  LOGIN_WINDOW_MINUTES: {
    schema: z.coerce.number().int().min(1).max(1440),
    hint: 'must be a whole number of minutes from 1 to 1440',
    default: 15,
  },
  TRUST_PROXY: {
    schema: booleanSetting,
    hint: 'must be true or false',
    default: false,
  },
  PUBLIC_FORM_ENABLED: {
    schema: booleanSetting,
    hint: 'must be true or false',
    default: false,
  },
  TURNSTILE_SECRET_KEY: {
    schema: z.string().min(1).max(200),
    hint: 'must be 1 to 200 characters',
    default: '',
  },
  TURNSTILE_VERIFY_URL: {
    schema: z.url({ protocol: /^https?$/, hostname: /^.+$/ }),
    hint: 'must be an http:// or https:// URL',
    default: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
  },
  TURNSTILE_EXPECTED_HOSTNAMES: {
    parse: (value) => {
      const result = parseHostnames(value);
      return result.ok ? { ok: true, data: result.hostnames } : result;
    },
    hint: '',
    default: [],
  },
  TURNSTILE_EXPECTED_ACTION: {
    schema: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
    hint: 'must be 1 to 32 characters of letters, digits, _ and -',
    default: '',
  },
  PUBLIC_MAX_PER_IP_PER_HOUR: {
    schema: z.coerce.number().int().min(1).max(10000),
    hint: 'must be a whole number from 1 to 10000',
    default: 5,
  },
  PUBLIC_DAILY_CAP: {
    schema: z.coerce.number().int().min(1).max(1000000),
    hint: 'must be a whole number from 1 to 1000000',
    default: 200,
  },
  MAIL_ENABLED: { schema: booleanSetting, hint: 'must be true or false', default: false },
  SMTP_HOST: { schema: z.string().min(1).max(253).regex(/^[A-Za-z0-9.-]+$/), hint: 'must be a host name', default: '' },
  SMTP_PORT: { schema: z.coerce.number().int().min(1).max(65535), hint: 'must be a whole number from 1 to 65535', default: 587 },
  SMTP_SECURE: { schema: booleanSetting, hint: 'must be true or false', default: false },
  SMTP_USER: { schema: z.string().min(1).max(200), hint: 'must be 1 to 200 characters', default: '' },
  SMTP_PASS: { schema: z.string().min(1).max(500), hint: 'must be 1 to 500 characters', default: '' },
  MAIL_FROM: { schema: mailAddressSetting, hint: 'must be an address such as support@example.com or Name <support@example.com>', default: '' },
  MAIL_REPLY_TO: { schema: mailAddressSetting, hint: 'must be an address such as support@example.com', default: '' },
  MAIL_MAX_PER_RECIPIENT_PER_DAY: {
    schema: z.coerce.number().int().min(1).max(1000),
    hint: 'must be a whole number from 1 to 1000',
    default: 3,
  },
};

const NAMES = Object.keys(SETTINGS) as (keyof AppConfig)[];

/** Thrown at startup. The message names each bad setting and never contains a value. */
export class ConfigValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid gateway configuration: ${problems.join('; ')}.`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Checks the environment and returns the typed settings.
 * Used as the `validate` option of ConfigModule, so a bad setting stops the app
 * from starting. Messages are built only from the setting NAME and a fixed hint,
 * so a secret in a URL can never end up in a log.
 */
export function validateEnv(raw: Record<string, unknown>): AppConfig {
  const problems: string[] = [];
  const values: Record<string, unknown> = {};

  for (const name of NAMES) {
    const value = raw[name];
    if (value === undefined || (typeof value === 'string' && value.trim() === '')) {
      if ('default' in SETTINGS[name]) {
        values[name] = SETTINGS[name].default;
      } else {
        problems.push(`${name} is missing`);
      }
      continue;
    }
    const { schema, parse } = SETTINGS[name];
    if (parse) {
      // Same rule as below: nothing that could carry the value may escape.
      let checked: ReturnType<typeof parse>;
      try {
        checked = parse(typeof value === 'string' ? value.trim() : '');
      } catch {
        checked = { ok: false, problems: ['could not be read'] };
      }
      if (checked.ok) values[name] = checked.data;
      else for (const problem of checked.problems) problems.push(`${name} is invalid (${problem})`);
      continue;
    }
    // Any failure, even an unexpected throw, becomes "invalid". A raw error could carry the value.
    let parsed: { success: boolean; data?: unknown };
    try {
      parsed = (schema as z.ZodType).safeParse(
        typeof value === 'string' ? value.trim() : value,
      );
    } catch {
      parsed = { success: false };
    }
    if (parsed.success) {
      values[name] = parsed.data;
    } else {
      problems.push(`${name} is invalid (${SETTINGS[name].hint})`);
    }
  }

  // Fail fast: an open public form with no way to check the bot test would let anyone spend the budget.
  if (values.PUBLIC_FORM_ENABLED === true && values.TURNSTILE_SECRET_KEY === '') {
    problems.push('TURNSTILE_SECRET_KEY is missing (required when PUBLIC_FORM_ENABLED is true)');
  }
  // Mail: with MAIL_ENABLED the server and the sender must be named (fail fast, not at the first reply), and a login is both or neither.
  const blank = (name: string) => raw[name] === undefined || (typeof raw[name] === 'string' && (raw[name] as string).trim() === '');
  if (values.MAIL_ENABLED === true) {
    for (const name of ['SMTP_HOST', 'SMTP_PORT', 'MAIL_FROM']) {
      if (blank(name)) problems.push(`${name} is missing (required when MAIL_ENABLED is true)`);
    }
  }
  if ((values.SMTP_USER === '') !== (values.SMTP_PASS === '')) {
    problems.push('SMTP_USER and SMTP_PASS must be set together (both or neither)');
  }
  if (problems.length > 0) {
    throw new ConfigValidationError(problems);
  }
  return values as unknown as AppConfig;
}
