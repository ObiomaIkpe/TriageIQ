import { z } from 'zod';

/** The validated settings the gateway needs to run. */
export interface AppConfig {
  PORT: number;
  REDIS_URL: string;
  TRIAGE_SERVICE_URL: string;
}

/** One entry per setting: how to check it, and a fixed hint shown when it is invalid. */
const SETTINGS = {
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
} as const;

type SettingName = keyof typeof SETTINGS;
const NAMES = Object.keys(SETTINGS) as SettingName[];

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
      problems.push(`${name} is missing`);
      continue;
    }
    // Any failure, even an unexpected throw, becomes "invalid". A raw error could carry the value.
    let parsed: { success: boolean; data?: unknown };
    try {
      parsed = SETTINGS[name].schema.safeParse(
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
