import { isSafeMethod, originAllowed } from './origin.js';

const ALLOWED = ['http://localhost:5173', 'https://reviews.example.com'];
const req = (origin?: string | string[]) => ({ headers: origin === undefined ? {} : { origin } }) as never;

describe('originAllowed: the Origin header must EXACTLY match an allowed origin', () => {
  it.each(ALLOWED)('accepts %s', (origin) => {
    expect(originAllowed(req(origin), ALLOWED)).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['null (a sandboxed or file page)', 'null'],
    ['empty', ''],
    ['a different host', 'http://evil.example.com'],
    ['a different port', 'http://localhost:5174'],
    ['a different scheme', 'https://localhost:5173'],
    ['http instead of https', 'http://reviews.example.com'],
    ['a trailing slash', 'http://localhost:5173/'],
    ['a path', 'http://localhost:5173/login'],
    ['different capitalisation', 'HTTP://LOCALHOST:5173'],
    ['a prefix of an allowed origin', 'http://localhost:517'],
    ['an allowed origin as a suffix of another host', 'http://localhost:5173.evil.com'],
    ['a subdomain', 'https://x.reviews.example.com'],
    ['two values', ['http://localhost:5173', 'http://localhost:5173'] as unknown as string],
  ])('refuses %s', (_label, origin) => {
    expect(originAllowed(req(origin), ALLOWED)).toBe(false);
  });

  it('with nothing allowed, everything is refused', () => {
    expect(originAllowed(req('http://localhost:5173'), [])).toBe(false);
  });
});

describe('isSafeMethod', () => {
  it.each(['GET', 'HEAD', 'OPTIONS', 'get', 'Head'])('%s needs no Origin check', (method) => {
    expect(isSafeMethod(method)).toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'TRACE', 'CONNECT', 'PROPFIND'])('%s does', (method) => {
    expect(isSafeMethod(method)).toBe(false);
  });
});
