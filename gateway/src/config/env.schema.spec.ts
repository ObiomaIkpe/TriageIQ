import { readFileSync } from 'node:fs';
import { ConfigModule } from '@nestjs/config';
import { afterEach, vi } from 'vitest';
import { configModuleOptions } from './config.options.js';
import { ConfigValidationError, validateEnv } from './env.schema.js';

const VALID = {
  PORT: '3000',
  REDIS_URL: 'redis://localhost:6379',
  TRIAGE_SERVICE_URL: 'http://localhost:8000',
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

  it.each(['PORT', 'REDIS_URL', 'TRIAGE_SERVICE_URL'])('%s missing -> error names it', (name) => {
    const env: Record<string, unknown> = { ...VALID };
    delete env[name];
    const error = failure(env);
    expect(error.message).toContain(`${name} is missing`);
    expect(error.problems).toHaveLength(1);
  });

  it.each(['PORT', 'REDIS_URL', 'TRIAGE_SERVICE_URL'])('%s empty or blank -> counts as missing', (name) => {
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
    for (const name of ['PORT', 'REDIS_URL', 'TRIAGE_SERVICE_URL']) {
      expect(error.message).toContain(name);
    }
    expect(error.problems).toHaveLength(3);
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
      if (match) env[match[1]] = match[2];
    }
    expect(Object.keys(env).sort()).toEqual(['PORT', 'REDIS_URL', 'TRIAGE_SERVICE_URL']);
    expect(() => validateEnv(env)).not.toThrow();
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

    await expect(
      ConfigModule.forRoot({ ...configModuleOptions, ignoreEnvFile: true }),
    ).resolves.toBeDefined();
  });
});
