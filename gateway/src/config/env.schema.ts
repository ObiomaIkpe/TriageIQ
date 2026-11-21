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
