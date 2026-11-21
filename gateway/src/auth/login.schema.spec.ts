import { EMAIL_FIELD_MAX, PASSWORD_FIELD_MAX, parseLogin } from './login.schema.js';

describe('parseLogin', () => {
  it('accepts email and password', () => {
    expect(parseLogin({ email: 'a@b.co', password: 'x' })).toEqual({ ok: true, data: { email: 'a@b.co', password: 'x' } });
  });

  it('limits: email at most 254, password at most 128', () => {
    expect(EMAIL_FIELD_MAX).toBe(254);
    expect(PASSWORD_FIELD_MAX).toBe(128);
    expect(parseLogin({ email: 'e'.repeat(254), password: 'p'.repeat(128) }).ok).toBe(true);
    expect(parseLogin({ email: 'e'.repeat(255), password: 'p' }).ok).toBe(false);
    expect(parseLogin({ email: 'e', password: 'p'.repeat(129) }).ok).toBe(false);
  });

  it.each([
    [{}],
    [{ email: 'a@b.co' }],
    [{ password: 'x' }],
    [{ email: '', password: 'x' }],
    [{ email: 'a@b.co', password: '' }],
    [{ email: 5, password: 'x' }],
    [{ email: 'a@b.co', password: null }],
    [{ email: ['a@b.co'], password: 'x' }],
    [{ email: 'a@b.co', password: 'x', remember: true }], // unknown fields are refused (strict)
    ['a@b.co'],
    [null],
    [[]],
  ])('refuses %j', (body) => {
    expect(parseLogin(body)).toEqual({ ok: false });
  });

  it('never reports why, so nothing typed can be echoed', () => {
    expect(JSON.stringify(parseLogin({ email: 'SECRETTYPED', password: 5 }))).not.toContain('SECRET');
  });
});
