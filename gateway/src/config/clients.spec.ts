import { ConfigValidationError, validateEnv } from './env.schema.js';
import { parseClients } from './clients.js';

const HASH = 'ab'.repeat(32);
const entry = (over: Record<string, unknown> = {}) => ({ name: 'alice', role: 'submitter', key_sha256: HASH, ...over });
const parse = (value: unknown) => parseClients(typeof value === 'string' ? value : JSON.stringify(value));

function problems(value: unknown): string[] {
  const result = parse(value);
  if (result.ok) throw new Error('expected a problem');
  return result.problems;
}

describe('parseClients', () => {
  it('accepts a valid registry and returns the entries', () => {
    const result = parse([entry(), entry({ name: 'ops-1', role: 'reviewer', key_sha256: 'cd'.repeat(32) })]);
    expect(result).toEqual({
      ok: true,
      clients: [
        { name: 'alice', role: 'submitter', key_sha256: HASH },
        { name: 'ops-1', role: 'reviewer', key_sha256: 'cd'.repeat(32) },
      ],
    });
  });

  it.each([
    ['not JSON', '{nope', 'is not valid JSON'],
    ['an object, not an array', '{"name":"a"}', 'must be a JSON array'],
    ['a string', '"x"', 'must be a JSON array'],
    ['an empty array (at least one client is required)', '[]', 'needs at least one client'],
  ])('%s', (_label, raw, expected) => {
    expect(problems(raw)).toEqual([expected]);
  });

  it.each([
    ['a name with capitals', { name: 'Alice' }],
    ['a name with an underscore', { name: 'a_b' }],
    ['a name with a space', { name: 'a b' }],
    ['an empty name', { name: '' }],
    ['a 41-character name', { name: 'a'.repeat(41) }],
    ['a name that is not text', { name: 5 }],
    ['no name', { name: undefined }],
  ])('rejects %s', (_label, over) => {
    expect(problems([entry(over)])).toEqual(['entry 1: name must be 1 to 40 characters of a-z, 0-9 and -']);
  });

  it('accepts a 1-character and a 40-character name', () => {
    expect(parse([entry({ name: 'a' }), entry({ name: 'a'.repeat(40), key_sha256: 'cd'.repeat(32) })]).ok).toBe(true);
  });

  it.each([['admin'], ['Submitter'], [''], [7], [undefined]])('rejects the role %j', (role) => {
    expect(problems([entry({ role })])).toEqual(['entry 1: role must be "submitter" or "reviewer"']);
  });

  it.each([
    ['too short', 'a'.repeat(63)],
    ['too long', 'a'.repeat(65)],
    ['upper case', 'A'.repeat(64)],
    ['not hex', 'g'.repeat(64)],
    ['not text', 12],
    ['missing', undefined],
  ])('rejects a key_sha256 that is %s', (_label, key_sha256) => {
    expect(problems([entry({ key_sha256 })])).toEqual([
      'entry 1: key_sha256 must be 64 lowercase hex characters',
    ]);
  });

  it('rejects a repeated name, naming the entries and not the name', () => {
    expect(problems([entry(), entry({ key_sha256: 'cd'.repeat(32) })])).toEqual([
      'entry 2 repeats the name of entry 1',
    ]);
  });

  it('rejects entries that are not objects, and unknown fields', () => {
    expect(problems(['x', null, []])).toEqual([
      'entry 1 must be an object',
      'entry 2 must be an object',
      'entry 3 must be an object',
    ]);
    expect(problems([entry({ extra: 1 })])).toEqual(['entry 1 has a field other than name, role and key_sha256']);
  });

  it('reports every bad entry in one go', () => {
    expect(problems([entry({ role: 'x' }), entry({ name: 'B' })])).toHaveLength(2);
  });

  it('never puts a name, a hash or any part of the value in a problem', () => {
    const secret = 'SECRETNAME';
    const all = [
      ...problems([{ name: secret, role: 'nope', key_sha256: 'SECRETHASH' }]),
      ...problems(`[{"name":"${secret}"`),
      ...problems([entry({ name: secret.toLowerCase() }), entry({ name: secret.toLowerCase() })]),
    ].join(' ');
    expect(all).not.toMatch(/SECRET|secretname/i);
    expect(all).not.toContain(HASH);
  });
});

describe('validateEnv with the client registry and the rate limit', () => {
  const VALID = {
    PORT: '3000',
    REDIS_URL: 'redis://localhost:6379',
    TRIAGE_SERVICE_URL: 'http://localhost:8000',
    GATEWAY_CLIENTS: JSON.stringify([entry()]),
    TRIAGE_REVIEW_API_KEY: 'a-review-key',
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

  it('refuses to start without GATEWAY_CLIENTS, and names it', () => {
    const { GATEWAY_CLIENTS: _omitted, ...without } = VALID;
    expect(failure(without).message).toContain('GATEWAY_CLIENTS is missing');
  });

  it.each(['[]', '{', '{"a":1}', '[{"name":"A","role":"x","key_sha256":"z"}]'])(
    'refuses an invalid GATEWAY_CLIENTS (%s), names it and shows no value',
    (bad) => {
      const error = failure({ ...VALID, GATEWAY_CLIENTS: bad });
      expect(error.message).toContain('GATEWAY_CLIENTS is invalid (');
      expect(error.message).not.toContain(bad);
    },
  );

  it('RATE_LIMIT_PER_MINUTE defaults to 60 and takes 1 to 10000', () => {
    expect(validateEnv(VALID).RATE_LIMIT_PER_MINUTE).toBe(60);
    expect(validateEnv({ ...VALID, RATE_LIMIT_PER_MINUTE: '1' }).RATE_LIMIT_PER_MINUTE).toBe(1);
    expect(validateEnv({ ...VALID, RATE_LIMIT_PER_MINUTE: '10000' }).RATE_LIMIT_PER_MINUTE).toBe(10000);
  });

  it.each(['0', '10001', '-5', '1.5', 'many'])('RATE_LIMIT_PER_MINUTE=%s is refused, naming it only', (value) => {
    const error = failure({ ...VALID, RATE_LIMIT_PER_MINUTE: value });
    expect(error.message).toContain('RATE_LIMIT_PER_MINUTE is invalid');
    expect(error.message).not.toContain(`=${value}`);
  });
});
