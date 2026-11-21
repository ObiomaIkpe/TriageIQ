import { FakeClock, MemorySessionStore } from '../../test/memory-stores.js';
import { SessionService } from './session.service.js';
import { hashSessionToken } from './session-token.js';

const USER = '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34';

function setup(idleMinutes = 60, absoluteHours = 8) {
  const clock = new FakeClock();
  const store = new MemorySessionStore(clock);
  const config = { get: (name: string) => ({ SESSION_IDLE_MINUTES: idleMinutes, SESSION_ABSOLUTE_HOURS: absoluteHours })[name] } as never;
  return { clock, store, service: new SessionService(store, config, clock.fn) };
}

describe('SessionService.create', () => {
  it('issues a fresh token, stores it under its SHA-256 only, and reports expiry and the cookie lifetime', async () => {
    const { service, store, clock } = setup();
    const session = await service.create(USER);

    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.hash).toBe(hashSessionToken(session.token));
    expect([...store.entries.keys()]).toEqual([session.hash]); // the raw token is nowhere in the store
    expect(JSON.stringify([...store.entries.values()])).not.toContain(session.token);
    expect(session.maxAgeSeconds).toBe(8 * 3600);
    expect(session.expiresAt.getTime()).toBe(clock.now + 3600_000); // idle expiry comes first
    expect(store.ttl(session.hash)).toBe(3600);
  });

  it('the stored record holds the user id and times, and nothing else', async () => {
    const { service, store } = setup();
    const session = await service.create(USER);
    expect(Object.keys(store.entries.get(session.hash)?.record ?? {}).sort((a, b) => a.localeCompare(b))).toEqual(['created_at', 'last_seen_at', 'user_id']);
  });

  it('every login gets a different token', async () => {
    const { service } = setup();
    expect((await service.create(USER)).token).not.toBe((await service.create(USER)).token);
  });

  it('is added to the user\'s index, so all of a user\'s sessions can be revoked', async () => {
    const { service, store } = setup();
    await service.create(USER);
    await service.create(USER);
    expect(store.index.get(USER)?.size).toBe(2);
  });
});

describe('SessionService.find', () => {
  it('finds a live session', async () => {
    const { service } = setup();
    const { token } = await service.create(USER);
    expect((await service.find(token))?.record.user_id).toBe(USER);
  });

  it.each(['', 'nope', 'a'.repeat(43), '../'.repeat(15)])('finds nothing for %j (and an unknown but well-formed token)', async (token) => {
    expect(await setup().service.find(token)).toBeUndefined();
  });

  describe('the idle timeout slides, but is written to Redis at most once a minute', () => {
    it('uses within a minute write nothing', async () => {
      const { service, store, clock } = setup();
      const { token } = await service.create(USER);
      for (const seconds of [10, 20, 59]) {
        clock.advanceSeconds(seconds - (clock.now - Date.parse('2026-11-21T12:00:00.000Z')) / 1000);
        await service.find(token);
      }
      expect(store.writes.touch).toBe(0);
    });

    it('a use after a minute slides the TTL back to the full idle timeout (one write)', async () => {
      const { service, store, clock } = setup();
      const { token, hash } = await service.create(USER);
      clock.advanceSeconds(1800); // 30 minutes in: 30 minutes of TTL left
      expect(store.ttl(hash)).toBe(1800);
      await service.find(token);
      expect(store.writes.touch).toBe(1);
      expect(store.ttl(hash)).toBe(3600);
    });

    it('many requests in a busy minute still make only one write', async () => {
      const { service, store, clock } = setup();
      const { token } = await service.create(USER);
      clock.advanceSeconds(120);
      for (let i = 0; i < 50; i += 1) {
        await service.find(token);
        clock.advance(100);
      }
      expect(store.writes.touch).toBe(1);
    });

    it('a second write happens once another minute has passed', async () => {
      const { service, store, clock } = setup();
      const { token } = await service.create(USER);
      clock.advanceSeconds(61);
      await service.find(token);
      clock.advanceSeconds(30);
      await service.find(token);
      clock.advanceSeconds(31);
      await service.find(token);
      expect(store.writes.touch).toBe(2);
    });

    it('the reported expiry follows the slide', async () => {
      const { service, clock } = setup();
      const { token } = await service.create(USER);
      clock.advanceSeconds(600);
      const live = await service.find(token);
      expect(live?.expiresAt.getTime()).toBe(clock.now + 3600_000);
    });
  });

  describe('idle expiry', () => {
    it('a session unused for the idle timeout is gone', async () => {
      const { service, clock } = setup(60);
      const { token } = await service.create(USER);
      clock.advanceSeconds(3599);
      expect(await service.find(token)).toBeDefined(); // and this use slid it
      clock.advanceSeconds(3601);
      expect(await service.find(token)).toBeUndefined();
    });

    it('regular use keeps a session alive past the idle timeout', async () => {
      const { service, clock } = setup(60);
      const { token } = await service.create(USER);
      for (let i = 0; i < 6; i += 1) {
        clock.advanceSeconds(1800); // every 30 minutes: always inside the 60-minute window
        expect(await service.find(token)).toBeDefined();
      }
    });

    it('a short idle setting is honoured', async () => {
      const { service, clock } = setup(2);
      const { token } = await service.create(USER);
      clock.advanceSeconds(121);
      expect(await service.find(token)).toBeUndefined();
    });
  });

  describe('absolute expiry', () => {
    it('ends the session at the absolute lifetime however busy it is', async () => {
      const { service, clock } = setup(60, 8);
      const { token } = await service.create(USER);
      for (let i = 0; i < 15; i += 1) {
        clock.advanceSeconds(1800); // used every 30 minutes: idle never expires
        expect(await service.find(token)).toBeDefined();
      }
      clock.advanceSeconds(1800); // now exactly 8 hours after login
      expect(await service.find(token)).toBeUndefined();
    });

    it('the service enforces the absolute lifetime itself, even if Redis still held the session (a TTL that was too long)', async () => {
      const { service, store, clock } = setup(60, 8);
      const hash = 'a'.repeat(64);
      const created = clock.now - 9 * 3600_000; // began 9 hours ago
      await store.create(hash, { user_id: USER, created_at: new Date(created).toISOString(), last_seen_at: new Date(clock.now).toISOString() }, 99_999, 99_999);
      // find() works on tokens, so look it up the way the service does: by the token's hash
      const token = 'T'.repeat(43);
      const { hashSessionToken } = await import('./session-token.js');
      await store.create(hashSessionToken(token), { user_id: USER, created_at: new Date(created).toISOString(), last_seen_at: new Date(clock.now).toISOString() }, 99_999, 99_999);
      expect(await service.find(token)).toBeUndefined();
      expect(store.entries.has(hashSessionToken(token))).toBe(false); // and it was deleted
    });

    it('near the end the TTL is cut to the remaining absolute time, and the reported expiry is the absolute one', async () => {
      const { service, store, clock } = setup(60, 8);
      const { token, hash } = await service.create(USER);
      for (let i = 0; i < 15; i += 1) {
        clock.advanceSeconds(1800); // used every 30 minutes, so idle never expires
        await service.find(token);
      }
      // 7.5 hours in: 30 minutes of absolute life left, less than the 60 idle minutes
      expect(store.ttl(hash)).toBe(1800);
      const live = await service.find(token);
      expect(live?.expiresAt.getTime()).toBe(Date.parse('2026-11-21T12:00:00.000Z') + 8 * 3600_000);
    });
  });
});

describe('SessionService.destroy and revoke', () => {
  it('destroy ends one session and says whether there was one', async () => {
    const { service } = setup();
    const { token } = await service.create(USER);
    expect(await service.destroy(token)).toBe(true);
    expect(await service.find(token)).toBeUndefined();
    expect(await service.destroy(token)).toBe(false); // again: nothing to do, no error
  });

  it('destroy ignores something that is not a token', async () => {
    expect(await setup().service.destroy('not a token')).toBe(false);
  });

  it('revokeAllForUser ends every session of that user only, and counts them', async () => {
    const { service } = setup();
    const a = await service.create(USER);
    const b = await service.create(USER);
    const other = await service.create('someone-else');
    expect(await service.revokeAllForUser(USER)).toBe(2);
    expect(await service.find(a.token)).toBeUndefined();
    expect(await service.find(b.token)).toBeUndefined();
    expect(await service.find(other.token)).toBeDefined();
    expect(await service.revokeAllForUser(USER)).toBe(0);
  });
});
