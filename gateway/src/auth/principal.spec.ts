import { clientPrincipal, userPrincipal } from './principal.js';

const UUID = '3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34';
const user = { id: UUID, email: 'ada@example.com', displayName: 'Ada' };

describe('principals', () => {
  it('a client is "client:<name>" and owns jobs under its bare name (what existing jobs hold)', () => {
    expect(clientPrincipal('alice', 'submitter')).toEqual({
      kind: 'client',
      id: 'client:alice',
      ownerId: 'alice',
      label: 'alice',
      name: 'alice',
      role: 'submitter',
    });
  });

  it('a user is "user:<uuid>", always a reviewer, and owns jobs as "user:<uuid>"', () => {
    const principal = userPrincipal(user, { hash: 'h'.repeat(64), expiresAt: new Date(0) });
    expect(principal).toMatchObject({ kind: 'user', id: `user:${UUID}`, ownerId: `user:${UUID}`, role: 'reviewer' });
  });

  it('the log label of a user is the id, never the email', () => {
    expect(userPrincipal(user, { hash: 'h', expiresAt: new Date(0) }).label).toBe(`user:${UUID}`);
  });

  it('ids never collide: a client named like a user cannot reach a user\'s namespace', () => {
    const asClient = clientPrincipal('user', 'submitter');
    const asUser = userPrincipal(user, { hash: 'h', expiresAt: new Date(0) });
    expect(asClient.id).toBe('client:user');
    expect(asClient.id).not.toBe(asUser.id);
    // Owner strings differ too: a bare client name never contains ":", a user's always does.
    expect(asClient.ownerId).not.toContain(':');
    expect(asUser.ownerId).toContain(':');
    expect(clientPrincipal('uuid-looking-name', 'submitter').ownerId).not.toBe(asUser.ownerId);
  });

  it('the namespaced ids make distinct rate-limit and idempotency keys for the same text', () => {
    const keys = new Set([
      `rl:${clientPrincipal('alice', 'submitter').id}`,
      `rl:${userPrincipal({ ...user, id: 'alice' }, { hash: 'h', expiresAt: new Date(0) }).id}`,
    ]);
    expect(keys.size).toBe(2);
  });

  it('holds the session hash, never a token', () => {
    const principal = userPrincipal(user, { hash: 'a'.repeat(64), expiresAt: new Date(0) });
    expect(JSON.stringify(principal)).not.toMatch(/token/i);
  });
});
