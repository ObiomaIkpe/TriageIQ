import { afterAll, beforeAll, vi } from 'vitest';
import { stubEnv } from './app-helpers.js';
import { login, startLoginApp, type LoginApp, withCookie, cookieOf } from './login-helpers.js';

/** COOKIE_SECURE=false: plain-http local development. Everything else about the cookie is unchanged. */
describe('COOKIE_SECURE=false (local http development)', () => {
  let world: LoginApp;

  beforeAll(() => {
    stubEnv();
    vi.stubEnv('COOKIE_SECURE', 'false');
  });
  afterAll(async () => {
    await world?.app.close();
    vi.unstubAllEnvs();
  });

  it('the session cookie has no Secure attribute, and keeps HttpOnly, SameSite=Strict, Path=/ and Max-Age', async () => {
    world = await startLoginApp();
    const response = await login(world).expect(200);
    const cookie = (response.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('tiq_session=')) as string;
    const parts = cookie.split('; ');
    expect(parts).not.toContain('Secure');
    expect(parts).toEqual(expect.arrayContaining(['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=28800']));
  });

  it('the clearing cookie on logout has the same attributes (also without Secure)', async () => {
    world = await startLoginApp();
    const cookie = cookieOf(await login(world).expect(200)) as string;
    const out = await withCookie(world, cookie).post('/auth/logout').expect(204);
    const cleared = (out.headers['set-cookie'] as unknown as string[])[0].split('; ');
    expect(cleared).not.toContain('Secure');
    expect(cleared).toEqual(expect.arrayContaining(['Max-Age=0', 'HttpOnly', 'SameSite=Strict', 'Path=/']));
  });
});
