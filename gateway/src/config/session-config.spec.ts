import { ConfigValidationError, validateEnv } from './env.schema.js';

const VALID = {
  PORT: '3000',
  REDIS_URL: 'redis://localhost:6379',
  TRIAGE_SERVICE_URL: 'http://localhost:8000',
  GATEWAY_CLIENTS: JSON.stringify([{ name: 'a', role: 'submitter', key_sha256: 'a'.repeat(64) }]),
  TRIAGE_REVIEW_API_KEY: 'k',
  GATEWAY_DATABASE_URL: 'postgresql://gateway:secret@db:5432/gateway',
};

function failure(env: Record<string, unknown>): ConfigValidationError {
  try {
    validateEnv(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigValidationError);
    return error as ConfigValidationError;
  }
  throw new Error('expected validateEnv to throw');
}

describe('session and login settings: defaults', () => {
  it('all are optional and default to the documented values', () => {
    const config = validateEnv(VALID);
    expect([
      config.SESSION_IDLE_MINUTES,
      config.SESSION_ABSOLUTE_HOURS,
      config.COOKIE_SECURE,
      config.ALLOWED_ORIGINS,
      config.LOGIN_MAX_FAILURES_PER_IP,
      config.LOGIN_MAX_FAILURES_PER_EMAIL,
      config.LOGIN_WINDOW_MINUTES,
      config.TRUST_PROXY,
    ]).toEqual([60, 8, true, [], 20, 5, 15, false]);
  });

  it('blank values count as unset (defaults apply)', () => {
    const config = validateEnv({ ...VALID, COOKIE_SECURE: '  ', ALLOWED_ORIGINS: '', SESSION_IDLE_MINUTES: '' });
    expect(config.COOKIE_SECURE).toBe(true);
    expect(config.ALLOWED_ORIGINS).toEqual([]);
    expect(config.SESSION_IDLE_MINUTES).toBe(60);
  });
});

describe('numeric settings', () => {
  it.each([
    ['SESSION_IDLE_MINUTES', '1', 1],
    ['SESSION_IDLE_MINUTES', '1440', 1440],
    ['SESSION_ABSOLUTE_HOURS', '1', 1],
    ['SESSION_ABSOLUTE_HOURS', '168', 168],
    ['LOGIN_MAX_FAILURES_PER_IP', '1', 1],
    ['LOGIN_MAX_FAILURES_PER_IP', '100000', 100000],
    ['LOGIN_MAX_FAILURES_PER_EMAIL', '1', 1],
    ['LOGIN_MAX_FAILURES_PER_EMAIL', '1000', 1000],
    ['LOGIN_WINDOW_MINUTES', '1', 1],
    ['LOGIN_WINDOW_MINUTES', '1440', 1440],
  ])('%s=%s is accepted', (name, value, expected) => {
    expect(validateEnv({ ...VALID, [name]: value })[name as 'LOGIN_WINDOW_MINUTES']).toBe(expected);
  });

  it.each([
    ['SESSION_IDLE_MINUTES', '0'],
    ['SESSION_IDLE_MINUTES', '1441'],
    ['SESSION_IDLE_MINUTES', '1.5'],
    ['SESSION_IDLE_MINUTES', 'soon'],
    ['SESSION_ABSOLUTE_HOURS', '0'],
    ['SESSION_ABSOLUTE_HOURS', '169'],
    ['SESSION_ABSOLUTE_HOURS', '-1'],
    ['LOGIN_MAX_FAILURES_PER_IP', '0'],
    ['LOGIN_MAX_FAILURES_PER_IP', '100001'],
    ['LOGIN_MAX_FAILURES_PER_EMAIL', '0'],
    ['LOGIN_MAX_FAILURES_PER_EMAIL', '1001'],
    ['LOGIN_WINDOW_MINUTES', '0'],
    ['LOGIN_WINDOW_MINUTES', '1441'],
    ['LOGIN_WINDOW_MINUTES', 'x'],
  ])('%s=%s is refused, naming the setting and never the value', (name, value) => {
    const error = failure({ ...VALID, [name]: value });
    expect(error.message).toContain(`${name} is invalid`);
    expect(error.message).not.toContain(`=${value}`);
    expect(error.problems).toHaveLength(1);
  });
});

describe('COOKIE_SECURE and TRUST_PROXY', () => {
  it.each([
    ['true', true],
    ['false', false],
    ['TRUE', true],
    ['False', false],
    ['  false  ', false],
  ])('COOKIE_SECURE=%j -> %s', (value, expected) => {
    expect(validateEnv({ ...VALID, COOKIE_SECURE: value }).COOKIE_SECURE).toBe(expected);
  });

  it.each([
    ['true', true],
    ['false', false],
  ])('TRUST_PROXY=%s -> %s', (value, expected) => {
    expect(validateEnv({ ...VALID, TRUST_PROXY: value }).TRUST_PROXY).toBe(expected);
  });

  it.each(['yes', 'no', '1', '0', 'on', 'off', 'tru', 'enabled'])(
    'anything but true or false (%s) is refused, so a typo can never switch a safety setting off',
    (value) => {
      expect(failure({ ...VALID, COOKIE_SECURE: value }).message).toContain('COOKIE_SECURE is invalid (must be true or false)');
      expect(failure({ ...VALID, TRUST_PROXY: value }).message).toContain('TRUST_PROXY is invalid (must be true or false)');
    },
  );
});

describe('ALLOWED_ORIGINS', () => {
  it('one origin', () => {
    expect(validateEnv({ ...VALID, ALLOWED_ORIGINS: 'http://localhost:5173' }).ALLOWED_ORIGINS).toEqual(['http://localhost:5173']);
  });

  it('several, with spaces around the commas, in order', () => {
    expect(
      validateEnv({ ...VALID, ALLOWED_ORIGINS: 'http://localhost:5173 , https://reviews.example.com' }).ALLOWED_ORIGINS,
    ).toEqual(['http://localhost:5173', 'https://reviews.example.com']);
  });

  it('is normalized: a trailing slash and capital letters in the host are tolerated and removed; duplicates collapse', () => {
    expect(
      validateEnv({ ...VALID, ALLOWED_ORIGINS: 'http://LOCALHOST:5173/,http://localhost:5173,https://a.example.com:443' }).ALLOWED_ORIGINS,
    ).toEqual(['http://localhost:5173', 'https://a.example.com:443'.replace(':443', '')]);
  });

  it.each([
    ['not a URL', 'localhost:5173'],
    ['a path', 'http://localhost:5173/app'],
    ['a query', 'http://localhost:5173?x=1'],
    ['a fragment', 'http://localhost:5173#x'],
    ['credentials', 'http://user:pw@localhost:5173'],
    ['another scheme', 'ftp://localhost:5173'],
    ['a wildcard', '*'],
    ['an empty entry', 'http://localhost:5173,,http://a.example.com'],
    ['a trailing comma', 'http://localhost:5173,'],
  ])('refuses %s', (_label, value) => {
    const error = failure({ ...VALID, ALLOWED_ORIGINS: value });
    expect(error.message).toContain('ALLOWED_ORIGINS is invalid (');
    expect(error.message).not.toContain(value);
  });

  it('names the entry by position and never repeats the value (a password could be in a URL)', () => {
    const error = failure({ ...VALID, ALLOWED_ORIGINS: 'http://ok.example.com,http://user:SECRETPASSWORD@bad.example.com' });
    expect(error.message).toContain('entry 2');
    expect(error.message).not.toContain('SECRETPASSWORD');
  });
});
