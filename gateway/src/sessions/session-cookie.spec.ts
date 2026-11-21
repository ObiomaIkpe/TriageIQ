import { SESSION_COOKIE_NAME } from './session.constants.js';
import { clearedSessionCookie, readSessionToken, sessionCookie } from './session-cookie.js';

const TOKEN = 'A'.repeat(43);

describe('sessionCookie', () => {
  it('is named tiq_session and is HttpOnly, SameSite=Strict, Path=/, Secure, with Max-Age = the absolute lifetime', () => {
    expect(SESSION_COOKIE_NAME).toBe('tiq_session');
    const header = sessionCookie(TOKEN, { secure: true, maxAgeSeconds: 28_800 });
    const parts = header.split('; ');
    expect(parts[0]).toBe(`tiq_session=${TOKEN}`);
    expect(parts).toEqual(expect.arrayContaining(['Max-Age=28800', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']));
    expect(parts).toHaveLength(6);
  });

  it('without COOKIE_SECURE the Secure attribute is absent, and everything else stays', () => {
    const parts = sessionCookie(TOKEN, { secure: false, maxAgeSeconds: 600 }).split('; ');
    expect(parts).not.toContain('Secure');
    expect(parts).toEqual(expect.arrayContaining(['Max-Age=600', 'Path=/', 'HttpOnly', 'SameSite=Strict']));
  });

  it('has no Domain (the cookie stays host-only) and no Expires', () => {
    const header = sessionCookie(TOKEN, { secure: true, maxAgeSeconds: 600 });
    expect(header).not.toMatch(/Domain=|Expires=/i);
  });
});

describe('clearedSessionCookie', () => {
  it('has the same name, path and attributes, an empty value, Max-Age=0 and a past Expires', () => {
    const parts = clearedSessionCookie({ secure: true }).split('; ');
    expect(parts[0]).toBe('tiq_session=');
    expect(parts).toEqual(expect.arrayContaining(['Max-Age=0', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT']));
  });

  it('keeps the Secure setting of the cookie it clears (identical attributes)', () => {
    expect(clearedSessionCookie({ secure: false }).split('; ')).not.toContain('Secure');
    const set = sessionCookie(TOKEN, { secure: false, maxAgeSeconds: 1 }).split('; ').slice(1).filter((p) => !p.startsWith('Max-Age'));
    const cleared = clearedSessionCookie({ secure: false }).split('; ').slice(1).filter((p) => !p.startsWith('Max-Age') && !p.startsWith('Expires'));
    expect(cleared.sort((a, b) => a.localeCompare(b))).toEqual(set.sort((a, b) => a.localeCompare(b)));
  });
});

describe('readSessionToken', () => {
  it.each([
    [`tiq_session=${TOKEN}`, TOKEN],
    [`a=1; tiq_session=${TOKEN}; b=2`, TOKEN],
    [`tiq_session=${TOKEN};`, TOKEN],
  ])('%s', (header, expected) => {
    expect(readSessionToken(header)).toBe(expected);
  });

  it.each([undefined, '', 'a=1', 'tiq_session=', 'other_tiq_session=x', 'TIQ_SESSION=x'])('finds nothing in %j', (header) => {
    expect(readSessionToken(header)).toBeUndefined();
  });

  it('with the cookie sent twice, the first one is used (the parser is not fooled into the last)', () => {
    expect(readSessionToken('tiq_session=first; tiq_session=second')).toBe('first');
  });

  it('a malformed header does not throw', () => {
    expect(() => readSessionToken('=;;;==; tiq_session')).not.toThrow();
  });
});
