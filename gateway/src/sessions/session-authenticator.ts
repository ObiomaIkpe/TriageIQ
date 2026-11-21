import { Inject, Injectable } from '@nestjs/common';
import { userPrincipal, type UserPrincipal } from '../auth/principal.js';
import { UsersRepository } from '../users/users.repository.js';
import { SESSION_CLOCK, type Clock } from './session.constants.js';
import { SessionService } from './session.service.js';

/**
 * The per-request check for a session cookie. It is the authoritative one:
 *  1. the session must exist and be within its idle and absolute lifetimes,
 *  2. the user row is loaded from Postgres (one primary-key query), and the session is REJECTED, and
 *     deleted, if the user is gone, is disabled, or changed their password after the session began.
 * Revoking sessions from the CLI is only clean-up: this check is what keeps a disabled reviewer out.
 */
@Injectable()
export class SessionAuthenticator {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(SESSION_CLOCK) private readonly clock: Clock,
  ) {}

  /** The reviewer behind a session token, or undefined. Infrastructure errors (Redis, Postgres) propagate. */
  async authenticate(token: string): Promise<UserPrincipal | undefined> {
    const session = await this.sessions.find(token);
    if (!session) return undefined;

    const user = await this.users.findById(session.record.user_id);
    const createdAt = Date.parse(session.record.created_at);
    if (!user || user.disabledAt !== null || user.passwordChangedAt.getTime() > createdAt) {
      await this.sessions.destroyByHash(session.hash);
      return undefined;
    }
    return userPrincipal(user, { hash: session.hash, expiresAt: session.expiresAt });
  }
}
