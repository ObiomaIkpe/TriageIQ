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

  if (problems.length > 0) {
    throw new ConfigValidationError(problems);
  }
  return values as unknown as AppConfig;
}
