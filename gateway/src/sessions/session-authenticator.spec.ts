import { FakeClock, MemorySessionStore, MemoryUsers } from '../../test/memory-stores.js';
import type { UsersRepository } from '../users/users.repository.js';
import { SessionAuthenticator } from './session-authenticator.js';
import { SessionService } from './session.service.js';

function setup() {
  const clock = new FakeClock();
  const store = new MemorySessionStore(clock);
  const users = new MemoryUsers(clock);
  const config = { get: (name: string) => ({ SESSION_IDLE_MINUTES: 60, SESSION_ABSOLUTE_HOURS: 8 })[name] } as never;
  const sessions = new SessionService(store, config, clock.fn);
  const authenticator = new SessionAuthenticator(sessions, users as unknown as UsersRepository, clock.fn);
  const user = users.add({ email: 'ada@example.com', passwordHash: '$argon2id$x', displayName: 'Ada' });
  return { clock, store, users, sessions, authenticator, user };
}

describe('SessionAuthenticator: the per-request check', () => {
  it('a valid session gives a user principal with the user\'s details and the session hash', async () => {
    const { authenticator, sessions, user } = setup();
    const { token, hash } = await sessions.create(user.id);

    const principal = await authenticator.authenticate(token);

    expect(principal).toMatchObject({
      kind: 'user',
      id: `user:${user.id}`,
      userId: user.id,
      email: 'ada@example.com',
      displayName: 'Ada',
      role: 'reviewer',
      sessionHash: hash,
    });
    expect(JSON.stringify(principal)).not.toContain(token);
  });

  it('loads the user from the database on EVERY request (the authoritative check)', async () => {
    const { authenticator, sessions, users, user } = setup();
    const { token } = await sessions.create(user.id);
    await authenticator.authenticate(token);
    await authenticator.authenticate(token);
    await authenticator.authenticate(token);
    expect(users.lookups.byId).toBe(3);
  });

  it('no session -> undefined, and the database is not asked', async () => {
    const { authenticator, users } = setup();
    expect(await authenticator.authenticate('a'.repeat(43))).toBeUndefined();
    expect(users.lookups.byId).toBe(0);
  });

  it('a user that no longer exists: rejected, and the session is deleted', async () => {
    const { authenticator, sessions, users, store, user } = setup();
    const { token, hash } = await sessions.create(user.id);
    users.rows.delete(user.id);
    expect(await authenticator.authenticate(token)).toBeUndefined();
    expect(store.entries.has(hash)).toBe(false);
  });

  it('a disabled user: rejected on the next request, and the session is deleted', async () => {
    const { authenticator, sessions, users, store, user } = setup();
    const { token, hash } = await sessions.create(user.id);
    expect(await authenticator.authenticate(token)).toBeDefined();
    users.disable(user.id);
    expect(await authenticator.authenticate(token)).toBeUndefined();
    expect(store.entries.has(hash)).toBe(false);
  });

  it('a password changed AFTER the session began: rejected, even though nothing revoked the session', async () => {
    const { authenticator, sessions, users, clock, user } = setup();
    const { token } = await sessions.create(user.id);
    clock.advanceSeconds(30);
    users.changePassword(user.id, '$argon2id$new');
    expect(await authenticator.authenticate(token)).toBeUndefined();
  });

  it('a password changed BEFORE the session began does not matter', async () => {
    const { authenticator, sessions, users, clock, user } = setup();
    users.changePassword(user.id, '$argon2id$new'); // at the current time
    clock.advanceSeconds(5);
    const { token } = await sessions.create(user.id); // login afterwards
    expect(await authenticator.authenticate(token)).toBeDefined();
  });

  it('a session past its absolute lifetime is rejected without asking the database', async () => {
    const { authenticator, sessions, users, clock, user } = setup();
    const { token } = await sessions.create(user.id);
    clock.advanceSeconds(8 * 3600);
    expect(await authenticator.authenticate(token)).toBeUndefined();
    expect(users.lookups.byId).toBe(0);
  });

  it('infrastructure errors propagate (the guard turns them into a 503), they are not "unauthenticated"', async () => {
    const { authenticator, sessions, users, user } = setup();
    const { token } = await sessions.create(user.id);
    users.findById = async () => {
      throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
    };
    await expect(authenticator.authenticate(token)).rejects.toThrow('down');
  });
});
