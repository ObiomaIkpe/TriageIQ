import { afterAll, beforeAll, vi } from 'vitest';
import { stubEnv } from './app-helpers.js';
import { login, startLoginApp, type LoginApp } from './login-helpers.js';

/** TRUST_PROXY=true: the client IP comes from X-Forwarded-For (only behind a proxy you control). */
describe('TRUST_PROXY=true', () => {
  let world: LoginApp;

  beforeAll(() => {
    stubEnv();
    vi.stubEnv('TRUST_PROXY', 'true');
  });
  afterAll(async () => {
    await world?.app.close();
    vi.unstubAllEnvs();
  });

  it('failures are counted per forwarded address, so one address being limited does not limit another', async () => {
    world = await startLoginApp();
    for (let i = 0; i < 20; i += 1) {
      await login(world, { email: `user${i}@example.com`, password: 'wrong wrong wrong' }, { forwardedFor: '198.51.100.7' }).expect(401);
    }
    await login(world, { email: 'new@example.com', password: 'wrong wrong wrong' }, { forwardedFor: '198.51.100.7' }).expect(429);
    // a different forwarded address is a different caller
    await login(world, { email: 'new@example.com', password: 'wrong wrong wrong' }, { forwardedFor: '203.0.113.9' }).expect(401);
    const keys = [...world.counters.entries.keys()].filter((k) => k.startsWith('login_fail:ip:'));
    expect(keys).toEqual(expect.arrayContaining(['login_fail:ip:198.51.100.7', 'login_fail:ip:203.0.113.9']));
  });
});
