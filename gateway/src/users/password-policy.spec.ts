import { COMMON_PASSWORDS, normalizePassword, passwordLength, validatePassword } from './password-policy.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from './password.constants.js';

const EMAIL = 'ada.lovelace@example.com';
const GOOD = 'a long and unusual passphrase';

const reason = (password: string, email = EMAIL) => {
  const result = validatePassword(password, email);
  return result.ok ? undefined : result.reason;
};

describe('validatePassword', () => {
  it('accepts a long passphrase, with no composition rules (no digits, capitals or symbols needed)', () => {
    expect(validatePassword(GOOD, EMAIL)).toEqual({ ok: true });
    expect(validatePassword('alllowercaseletters', EMAIL)).toEqual({ ok: true });
    expect(validatePassword('            ', EMAIL)).toEqual({ ok: true }); // length is the rule, not content
  });

  describe('length: 12 to 128 characters', () => {
    it('limits are the documented ones', () => {
      expect(PASSWORD_MIN_LENGTH).toBe(12);
      expect(PASSWORD_MAX_LENGTH).toBe(128);
    });

    it('11 characters is too short, 12 is fine', () => {
      expect(reason('x'.repeat(11))).toBe('The password must be at least 12 characters long.');
      expect(validatePassword('x7'.repeat(6), EMAIL)).toEqual({ ok: true });
      expect(validatePassword('abcdefghijkl', EMAIL)).toEqual({ ok: true });
    });

    it('128 characters is fine, 129 is too long', () => {
      expect(validatePassword('ab'.repeat(64), EMAIL)).toEqual({ ok: true });
      expect(reason('ab'.repeat(64) + 'c')).toBe('The password must be at most 128 characters long.');
    });

    it('an empty password is too short', () => {
      expect(reason('')).toBe('The password must be at least 12 characters long.');
    });

    it('counts characters, not UTF-16 units: 12 emoji pass, 11 do not', () => {
      expect(validatePassword('😀'.repeat(12), EMAIL)).toEqual({ ok: true });
      expect(reason('😀'.repeat(11))).toMatch(/at least 12/);
      expect(passwordLength('😀')).toBe(1);
    });
  });

  describe('Unicode NFC normalization', () => {
    const composed = 'é'; // one code point
    const decomposed = 'é'; // two code points, the same letter

    it('normalizes before counting: 11 composed + decomposed é is 12 characters', () => {
      expect(normalizePassword(decomposed)).toBe(composed);
      expect(passwordLength(composed.repeat(6) + decomposed.repeat(6))).toBe(12);
      expect(validatePassword(composed.repeat(6) + decomposed.repeat(6), EMAIL)).toEqual({ ok: true });
    });

    it('decomposed characters cannot be used to slip past the maximum', () => {
      // 129 letters typed as e + combining accent = 258 code points raw, 129 after NFC.
      expect(reason(decomposed.repeat(129))).toMatch(/at most 128/);
      expect(validatePassword(decomposed.repeat(128), EMAIL)).toEqual({ ok: true });
    });
  });

  describe('not the email', () => {
    it.each([
      EMAIL,
      EMAIL.toUpperCase(),
      'Ada.Lovelace@Example.com',
      'ada.lovelace', // the part before the @
      'ADA.LOVELACE',
    ])('rejects %j', (password) => {
      // pad nothing: these are all at least 12 characters, so only the email rule can reject them
      expect(password.length).toBeGreaterThanOrEqual(12);
      expect(reason(password)).toBe('The password must not be the email address or the part of it before the @.');
    });

    it('a password that merely contains the email is fine', () => {
      expect(validatePassword(`${EMAIL} plus more words`, EMAIL)).toEqual({ ok: true });
      expect(validatePassword('ada.lovelace!!', EMAIL)).toEqual({ ok: true });
    });

    it('works for an email with capitals or spaces around it', () => {
      expect(reason('ada.lovelace', '  ADA.Lovelace@Example.com ')).toMatch(/must not be the email/);
    });

    it('the local part is compared after NFC too', () => {
      expect(reason('josé.garcía.x', 'josé.garcía.x@example.com')).toMatch(/must not be the email/);
    });
  });

  describe('common passwords', () => {
    it('the built-in list is short (about 20) and every entry would otherwise pass the length rule', () => {
      expect(COMMON_PASSWORDS.length).toBeGreaterThanOrEqual(15);
      expect(COMMON_PASSWORDS.length).toBeLessThanOrEqual(30);
      for (const password of COMMON_PASSWORDS) expect(password.length).toBeGreaterThanOrEqual(12);
    });

    it.each(['password1234', 'qwertyuiop12', '1q2w3e4r5t6y', 'PASSWORD1234', 'QwertyUiop12'])(
      'rejects %j (any capitalisation)',
      (password) => {
        expect(reason(password)).toBe('That password is too common. Choose a different one.');
      },
    );

    it('every listed password is rejected', () => {
      for (const password of COMMON_PASSWORDS) {
        expect(validatePassword(password, EMAIL).ok).toBe(false);
      }
    });

    it('a password that only starts with a common one is fine', () => {
      expect(validatePassword('password1234 and a whole lot more', EMAIL)).toEqual({ ok: true });
    });
  });

  it('the messages are clear sentences and never repeat the password', () => {
    for (const password of ['short', 'password1234', 'x'.repeat(200), 'ada.lovelace@example.com']) {
      const message = reason(password) ?? '';
      expect(message).toMatch(/^The password|^That password/);
      expect(message.endsWith('.')).toBe(true);
      expect(message).not.toContain(password.slice(0, 12) === 'x'.repeat(12) ? 'xxxx' : password);
    }
  });

  it('is pure: the same input gives the same answer', () => {
    expect(validatePassword(GOOD, EMAIL)).toEqual(validatePassword(GOOD, EMAIL));
    expect(validatePassword('short', EMAIL)).toEqual(validatePassword('short', EMAIL));
  });
});
