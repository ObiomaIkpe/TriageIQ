import { readFileSync } from 'node:fs';
import { ConfigModule } from '@nestjs/config';
import { afterEach, vi } from 'vitest';
import { configModuleOptions } from './config.options.js';
import { ConfigValidationError, validateEnv } from './env.schema.js';

const HASH = 'a'.repeat(64);
const CLIENTS = [{ name: 'alice', role: 'submitter', key_sha256: HASH }];

const VALID = {
  PORT: '3000',
  REDIS_URL: 'redis://localhost:6379',
  TRIAGE_SERVICE_URL: 'http://localhost:8000',
  GATEWAY_CLIENTS: JSON.stringify(CLIENTS),
  TRIAGE_REVIEW_API_KEY: 'a-review-key',
  GATEWAY_DATABASE_URL: 'postgresql://gateway:secret@db:5432/gateway',
};

/** A marker that must never show up in an error message. */
const SECRET = 'SECRETVALUE123';

function failure(env: Record<string, unknown>): ConfigValidationError {
  try {
    validateEnv(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    return error as ConfigValidationError;
  }
  throw new Error('expected validateEnv to throw');
}

describe('validateEnv', () => {
  it('loads a valid config, with PORT as a number', () => {
    expect(validateEnv(VALID)).toEqual({
      PORT: 3000,
      REDIS_URL: 'redis://localhost:6379',
      TRIAGE_SERVICE_URL: 'http://localhost:8000',
      // The two optional settings fall back to their defaults.
      WORKER_CONCURRENCY: 2,
      TRIAGE_TIMEOUT_MS: 120000,
      GATEWAY_CLIENTS: CLIENTS,
      RATE_LIMIT_PER_MINUTE: 60,
      TRIAGE_REVIEW_API_KEY: 'a-review-key',
      GATEWAY_DATABASE_URL: 'postgresql://gateway:secret@db:5432/gateway',
      // The new session and login settings fall back to their defaults.
      SESSION_IDLE_MINUTES: 60,
      SESSION_ABSOLUTE_HOURS: 8,
      COOKIE_SECURE: true, // fail safe: Secure unless switched off
      ALLOWED_ORIGINS: [],
      LOGIN_MAX_FAILURES_PER_IP: 20,
      LOGIN_MAX_FAILURES_PER_EMAIL: 5,
      LOGIN_WINDOW_MINUTES: 15,
      TRUST_PROXY: false,
      PUBLIC_FORM_ENABLED: false,
      TURNSTILE_SECRET_KEY: '',
      TURNSTILE_VERIFY_URL: 'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      TURNSTILE_EXPECTED_HOSTNAMES: [],
      TURNSTILE_EXPECTED_ACTION: '',
      PUBLIC_MAX_PER_IP_PER_HOUR: 5,
      PUBLIC_DAILY_CAP: 200,
      MAIL_ENABLED: false,
      SMTP_HOST: '',
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      SMTP_USER: '',
      SMTP_PASS: '',
      MAIL_FROM: '',
      MAIL_REPLY_TO: '',
      MAIL_MAX_PER_RECIPIENT_PER_DAY: 3,
    });
  });

  it('accepts rediss:// and https:// URLs', () => {
    const config = validateEnv({
      ...VALID,
      REDIS_URL: 'rediss://:pw@cache.example.com:6380/1',
      TRIAGE_SERVICE_URL: 'https://triage.example.com',
    });
    expect(config.REDIS_URL).toContain('rediss://');
  });

  it.each(['PORT', 'REDIS_URL', 'TRIAGE_SERVICE_URL', 'GATEWAY_CLIENTS', 'TRIAGE_REVIEW_API_KEY', 'GATEWAY_DATABASE_URL'])('%s missing -> error names it', (name) => {
    const env: Record<string, unknown> = { ...VALID };
    delete env[name];
    const error = failure(env);
    expect(error.message).toContain(`${name} is missing`);
    expect(error.problems).toHaveLength(1);
  });

  it.each(['PORT', 'REDIS_URL', 'TRIAGE_SERVICE_URL', 'GATEWAY_CLIENTS', 'TRIAGE_REVIEW_API_KEY', 'GATEWAY_DATABASE_URL'])('%s empty or blank -> counts as missing', (name) => {
    expect(failure({ ...VALID, [name]: '   ' }).message).toContain(`${name} is missing`);
    expect(failure({ ...VALID, [name]: '' }).message).toContain(`${name} is missing`);
  });

  it.each([
    ['PORT', 'abc'],
    ['PORT', '0'],
    ['PORT', '70000'],
    ['PORT', '30.5'],
    ['PORT', '-1'],
    ['REDIS_URL', 'not a url'],
    ['REDIS_URL', 'http://localhost:6379'],
    ['REDIS_URL', 'localhost:6379'],
    ['TRIAGE_SERVICE_URL', 'ftp://localhost:8000'],
    ['TRIAGE_SERVICE_URL', 'localhost:8000'],
    ['TRIAGE_SERVICE_URL', 'nonsense'],
  ])('%s=%s -> invalid, error names it', (name, value) => {
    const error = failure({ ...VALID, [name]: value });
    expect(error.message).toContain(`${name} is invalid`);
  });

  it('names every bad setting at once', () => {
    const error = failure({});
    for (const name of ['PORT', 'REDIS_URL', 'TRIAGE_SERVICE_URL', 'GATEWAY_CLIENTS', 'TRIAGE_REVIEW_API_KEY', 'GATEWAY_DATABASE_URL']) {
      expect(error.message).toContain(name);
    }
    expect(error.problems).toHaveLength(6);
  });

  it('a missing or blank TRIAGE_REVIEW_API_KEY stops startup, naming the setting and never a value', () => {
    const { TRIAGE_REVIEW_API_KEY: _omitted, ...without } = VALID;
    expect(failure(without).message).toContain('TRIAGE_REVIEW_API_KEY is missing');
    expect(failure({ ...without, TRIAGE_REVIEW_API_KEY: '   ' }).message).toContain('TRIAGE_REVIEW_API_KEY is missing');
    expect(validateEnv(VALID).TRIAGE_REVIEW_API_KEY).toBe('a-review-key');
  });

  it.each([
    ['not a url', 'GATEWAY_DATABASE_URL'],
    ['http://db:5432/gateway', 'GATEWAY_DATABASE_URL'],
    ['mysql://u:p@db/gateway', 'GATEWAY_DATABASE_URL'],
    ['db:5432/gateway', 'GATEWAY_DATABASE_URL'],
  ])('GATEWAY_DATABASE_URL=%s is refused, naming the setting and never the value', (value, name) => {
    const error = failure({ ...VALID, [name]: value });
    expect(error.message).toContain('GATEWAY_DATABASE_URL is invalid (must be a postgresql:// URL)');
    expect(error.message).not.toContain(value);
  });

  it('accepts postgresql:// and postgres:// URLs, and a password never shows in an error', () => {
    expect(validateEnv({ ...VALID, GATEWAY_DATABASE_URL: 'postgres://gateway:pw@db:5432/gateway' }).GATEWAY_DATABASE_URL).toContain('postgres://');
    const error = failure({ ...VALID, GATEWAY_DATABASE_URL: 'http://gateway:SECRETPASSWORD@db/gateway' });
    expect(error.message).not.toContain('SECRETPASSWORD');
  });

  it('never puts a setting value in the error', () => {
    const error = failure({
      PORT: `${SECRET}-port`,
      REDIS_URL: `${SECRET}-redis`,
      TRIAGE_SERVICE_URL: `${SECRET}-triage`,
    });
    expect(error.message).not.toContain(SECRET);
    expect(JSON.stringify(error.problems)).not.toContain(SECRET);

    // A real-looking URL with a password, made invalid by its scheme.
    const withPassword = failure({ ...VALID, REDIS_URL: `http://user:${SECRET}@host:6379` });
    expect(withPassword.message).not.toContain(SECRET);
  });

  it('accepts every value in gateway/.env.example', () => {
    const text = readFileSync(new URL('../../.env.example', import.meta.url), 'utf8');
    const env: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const match = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      // Like dotenv and compose: a value in single quotes is taken literally, quotes removed.
      if (match) env[match[1]] = match[2].replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
    }
    expect(Object.keys(env).sort()).toEqual([
      'ALLOWED_ORIGINS',
      'COOKIE_SECURE',
      'GATEWAY_CLIENTS',
      'GATEWAY_DATABASE_URL',
      'LOGIN_MAX_FAILURES_PER_EMAIL',
      'LOGIN_MAX_FAILURES_PER_IP',
      'LOGIN_WINDOW_MINUTES',
      'MAIL_ENABLED',
      'MAIL_FROM',
      'PORT',
      'PUBLIC_DAILY_CAP',
      'PUBLIC_FORM_ENABLED',
      'PUBLIC_MAX_PER_IP_PER_HOUR',
      'RATE_LIMIT_PER_MINUTE',
      'REDIS_URL',
      'SESSION_ABSOLUTE_HOURS',
      'SESSION_IDLE_MINUTES',
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_SECURE',
      'TRIAGE_REVIEW_API_KEY',
      'TRIAGE_SERVICE_URL',
      'TRIAGE_TIMEOUT_MS',
      'TRUST_PROXY',
      'WORKER_CONCURRENCY',
    ]);
    expect(() => validateEnv(env)).not.toThrow();
  });
});

describe('worker settings', () => {
  it('use their defaults when missing or blank', () => {
    for (const blank of [undefined, '', '   ']) {
      const config = validateEnv({ ...VALID, WORKER_CONCURRENCY: blank, TRIAGE_TIMEOUT_MS: blank });
      expect(config.WORKER_CONCURRENCY).toBe(2);
      expect(config.TRIAGE_TIMEOUT_MS).toBe(120000);
    }
  });

  it('are read as numbers', () => {
    const config = validateEnv({ ...VALID, WORKER_CONCURRENCY: '10', TRIAGE_TIMEOUT_MS: '1000' });
    expect(config.WORKER_CONCURRENCY).toBe(10);
    expect(config.TRIAGE_TIMEOUT_MS).toBe(1000);
    expect(validateEnv({ ...VALID, TRIAGE_TIMEOUT_MS: '600000' }).TRIAGE_TIMEOUT_MS).toBe(600000);
    expect(validateEnv({ ...VALID, WORKER_CONCURRENCY: '1' }).WORKER_CONCURRENCY).toBe(1);
  });

  it.each([
    ['WORKER_CONCURRENCY', '0'],
    ['WORKER_CONCURRENCY', '11'],
    ['WORKER_CONCURRENCY', '2.5'],
    ['WORKER_CONCURRENCY', '-1'],
    ['WORKER_CONCURRENCY', 'many'],
    ['TRIAGE_TIMEOUT_MS', '999'],
    ['TRIAGE_TIMEOUT_MS', '600001'],
    ['TRIAGE_TIMEOUT_MS', '1500.5'],
    ['TRIAGE_TIMEOUT_MS', 'soon'],
  ])('%s=%s -> invalid, error names it and not the value', (name, value) => {
    const error = failure({ ...VALID, [name]: value });
    expect(error.message).toContain(`${name} is invalid`);
    expect(error.message).not.toContain(`=${value}`);
    expect(error.problems).toHaveLength(1);
  });

  it('never put an invalid value in the error', () => {
    const error = failure({
      ...VALID,
      WORKER_CONCURRENCY: `${SECRET}-a`,
      TRIAGE_TIMEOUT_MS: `${SECRET}-b`,
    });
    expect(error.message).not.toContain(SECRET);
    expect(error.problems).toHaveLength(2);
  });
});

describe('startup with a bad environment', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // In @nestjs/config 12, forRoot returns a promise, and Nest awaits it while building the app.
  it('ConfigModule.forRoot (as AppModule calls it) refuses, naming the setting and not its value', async () => {
    vi.stubEnv('PORT', '');
    vi.stubEnv('REDIS_URL', `${SECRET}-redis`);
    vi.stubEnv('TRIAGE_SERVICE_URL', 'http://localhost:8000');

    let message = '';
    try {
      await ConfigModule.forRoot({ ...configModuleOptions, ignoreEnvFile: true });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      message = (error as Error).message;
    }

    expect(message).toContain('PORT is missing');
    expect(message).toContain('REDIS_URL is invalid');
    expect(message).not.toContain(SECRET);
  });

  it('ConfigModule.forRoot loads a valid environment', async () => {
    vi.stubEnv('PORT', '3000');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6379');
    vi.stubEnv('TRIAGE_SERVICE_URL', 'http://localhost:8000');
    vi.stubEnv('GATEWAY_CLIENTS', JSON.stringify(CLIENTS));
    vi.stubEnv('TRIAGE_REVIEW_API_KEY', 'a-review-key');
    vi.stubEnv('GATEWAY_DATABASE_URL', 'postgresql://gateway:secret@db:5432/gateway');

    await expect(
      ConfigModule.forRoot({ ...configModuleOptions, ignoreEnvFile: true }),
    ).resolves.toBeDefined();
  });
});

describe('validateEnv: the public form settings', () => {
  const on = { ...VALID, PUBLIC_FORM_ENABLED: 'true', TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' };

  it('is off by default and needs no Turnstile secret then', () => {
    const config = validateEnv(VALID);
    expect(config.PUBLIC_FORM_ENABLED).toBe(false);
    expect(config.TURNSTILE_SECRET_KEY).toBe('');
  });

  it('refuses to start when enabled without a secret (fail fast), naming the setting and never a value', () => {
    for (const secret of [undefined, '', '   ']) {
      const error = failure({ ...VALID, PUBLIC_FORM_ENABLED: 'true', TURNSTILE_SECRET_KEY: secret });
      expect(error.problems).toEqual(['TURNSTILE_SECRET_KEY is missing (required when PUBLIC_FORM_ENABLED is true)']);
    }
  });

  it('starts when enabled with a secret', () => {
    expect(validateEnv(on).PUBLIC_FORM_ENABLED).toBe(true);
  });

  it('is strict about the flag: only true or false', () => {
    expect(failure({ ...VALID, PUBLIC_FORM_ENABLED: 'yes' }).problems[0]).toContain('PUBLIC_FORM_ENABLED is invalid');
    expect(validateEnv({ ...VALID, PUBLIC_FORM_ENABLED: 'FALSE' }).PUBLIC_FORM_ENABLED).toBe(false);
  });

  it.each([
    ['PUBLIC_MAX_PER_IP_PER_HOUR', '0', false], ['PUBLIC_MAX_PER_IP_PER_HOUR', '1', true], ['PUBLIC_MAX_PER_IP_PER_HOUR', '10000', true],
    ['PUBLIC_MAX_PER_IP_PER_HOUR', '10001', false], ['PUBLIC_MAX_PER_IP_PER_HOUR', '2.5', false], ['PUBLIC_MAX_PER_IP_PER_HOUR', 'abc', false],
    ['PUBLIC_DAILY_CAP', '0', false], ['PUBLIC_DAILY_CAP', '1', true], ['PUBLIC_DAILY_CAP', '1000000', true], ['PUBLIC_DAILY_CAP', '1000001', false],
    ['TURNSTILE_VERIFY_URL', 'https://example.com/siteverify', true], ['TURNSTILE_VERIFY_URL', 'http://localhost:9999/x', true],
    ['TURNSTILE_VERIFY_URL', 'ftp://example.com', false], ['TURNSTILE_VERIFY_URL', 'nope', false],
    ['TURNSTILE_EXPECTED_ACTION', 'public_ticket', true], ['TURNSTILE_EXPECTED_ACTION', 'has space', false], ['TURNSTILE_EXPECTED_ACTION', 'x'.repeat(33), false],
    ['TURNSTILE_EXPECTED_HOSTNAMES', 'example.com', true], ['TURNSTILE_EXPECTED_HOSTNAMES', 'a.example.com, B.example.org', true],
    ['TURNSTILE_EXPECTED_HOSTNAMES', 'https://example.com', false], ['TURNSTILE_EXPECTED_HOSTNAMES', 'example.com:3000', false],
    ['TURNSTILE_EXPECTED_HOSTNAMES', 'a.com,,b.com', false],
  ])('%s = %j -> valid %s', (name, value, valid) => {
    const run = () => validateEnv({ ...VALID, [name]: value });
    if (valid) expect(run).not.toThrow();
    else expect(run).toThrow(ConfigValidationError);
  });

  it('the defaults are 5 per IP per hour and 200 per day', () => {
    const config = validateEnv(VALID);
    expect([config.PUBLIC_MAX_PER_IP_PER_HOUR, config.PUBLIC_DAILY_CAP]).toEqual([5, 200]);
  });

  it('hostnames are lower-cased and de-duplicated', () => {
    expect(validateEnv({ ...VALID, TURNSTILE_EXPECTED_HOSTNAMES: 'A.com, a.com, b.com' }).TURNSTILE_EXPECTED_HOSTNAMES).toEqual(['a.com', 'b.com']);
  });

  it('the secret never appears in an error message', () => {
    const error = failure({ ...VALID, PUBLIC_FORM_ENABLED: 'maybe', TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_VERIFY_URL: `ftp://${SECRET}` });
    expect(error.message).not.toContain(SECRET);
  });
});

describe('validateEnv: the mail settings', () => {
  const on = { ...VALID, MAIL_ENABLED: 'true', SMTP_HOST: 'mailpit', SMTP_PORT: '1025', MAIL_FROM: 'TriageIQ Support <support@triageiq.local>' };

  it('is off by default and needs nothing else then', () => {
    expect(validateEnv(VALID).MAIL_ENABLED).toBe(false);
  });

  it('enabled: the host, the port and the sender are required (fail fast, by name)', () => {
    for (const missing of ['SMTP_HOST', 'SMTP_PORT', 'MAIL_FROM']) {
      const env: Record<string, unknown> = { ...on };
      delete env[missing];
      expect(failure(env).problems).toEqual([`${missing} is missing (required when MAIL_ENABLED is true)`]);
    }
  });

  it('enabled with everything set: starts, with the typed values', () => {
    expect(validateEnv(on)).toMatchObject({ MAIL_ENABLED: true, SMTP_HOST: 'mailpit', SMTP_PORT: 1025, SMTP_SECURE: false, MAIL_FROM: 'TriageIQ Support <support@triageiq.local>', MAIL_MAX_PER_RECIPIENT_PER_DAY: 3 });
  });

  it('SMTP_USER and SMTP_PASS go together: both or neither, and no secret is ever in the message', () => {
    expect(validateEnv({ ...on, SMTP_USER: 'u', SMTP_PASS: 'p' }).SMTP_USER).toBe('u');
    expect(failure({ ...on, SMTP_USER: 'u' }).problems).toEqual(['SMTP_USER and SMTP_PASS must be set together (both or neither)']);
    const error = failure({ ...on, SMTP_PASS: SECRET });
    expect(error.message).not.toContain(SECRET);
  });

  it.each([
    ['SMTP_PORT', '0', false], ['SMTP_PORT', '65536', false], ['SMTP_PORT', '465', true],
    ['SMTP_SECURE', 'yes', false], ['SMTP_SECURE', 'true', true],
    ['MAIL_FROM', 'support@example.com', true], ['MAIL_FROM', 'Support <support@example.com>', true],
    ['MAIL_FROM', 'no-at-sign', false], ['MAIL_FROM', 'a@b.c\r\nBcc: x@y.z', false], ['MAIL_FROM', 'Name\r\n <a@b.c>', false],
    ['MAIL_REPLY_TO', 'help@example.com', true], ['MAIL_REPLY_TO', 'bad', false],
    ['MAIL_MAX_PER_RECIPIENT_PER_DAY', '0', false], ['MAIL_MAX_PER_RECIPIENT_PER_DAY', '1', true], ['MAIL_MAX_PER_RECIPIENT_PER_DAY', '1001', false],
    ['SMTP_HOST', 'smtp.example.com', true], ['SMTP_HOST', 'bad host!', false],
  ])('%s = %j -> valid %s', (name, value, valid) => {
    const run = () => validateEnv({ ...on, [name]: value });
    if (valid) expect(run).not.toThrow();
    else expect(run).toThrow(ConfigValidationError);
  });
});

