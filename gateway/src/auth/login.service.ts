import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type IssuedSession, SessionService } from '../sessions/session.service.js';
import { normalizeEmail } from '../users/normalize.js';
import { PasswordHasher } from '../users/password-hasher.js';
import type { User } from '../users/user.types.js';
import { UsersRepository } from '../users/users.repository.js';
import { LoginLimiter } from './login-limiter.js';

const logger = new Logger('Login');

export interface LoginAttempt {
  email: string;
  password: string;
  ip: string;
  /** The session token the request already carried, if any. It is ended on a successful login. */
  oldToken?: string;
}

export type LoginOutcome =
  | { kind: 'success'; user: User; session: IssuedSession }
  | { kind: 'invalid' }
  | { kind: 'limited'; retryAfterSeconds: number };

export type FailureReason = 'unknown_email' | 'wrong_password' | 'disabled';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Checks a login. Every way of failing (unknown email, wrong password, disabled account) does the
 * same work, a full password verification, and is reported to the caller the same way ('invalid').
 * The reason only goes to the log, with the user's id when it is known, never with what was typed.
 */
@Injectable()
export class LoginService {
  constructor(
    @Inject(UsersRepository) private readonly users: UsersRepository,
    @Inject(PasswordHasher) private readonly hasher: PasswordHasher,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(LoginLimiter) private readonly limiter: LoginLimiter,
  ) {}

  async login(attempt: LoginAttempt): Promise<LoginOutcome> {
    const email = normalizeEmail(attempt.email);
    const emailHash = sha256(email); // the email itself is never stored or logged

    // 1. Count the attempt and check the limits in ONE atomic step, before any password work: a limited
    //    caller costs no hashing, and a burst of concurrent attempts cannot slip past the limit.
    const decision = await this.limiter.attempt(attempt.ip, emailHash);
    if (decision.limited) {
      logger.warn(`login outcome=failure reason=${decision.reason} ip=${attempt.ip}`);
      return { kind: 'limited', retryAfterSeconds: decision.retryAfterSeconds };
    }

    // 2. Always verify a password: against the real hash, or against the dummy one when the email is unknown.
    const user = await this.users.findByEmail(email);
    // The demo user has no password at all: whatever is typed, it is a failure, and it does the same work as any other failure.
    const isDemo = user?.role === 'demo';
    const passwordOk = await this.hasher.verify(user && !isDemo ? user.passwordHash : this.hasher.dummyHash, attempt.password);

    // 3. Decide, after the verification, so every path took comparable time.
    const reason: FailureReason | undefined = !user
      ? 'unknown_email'
      : isDemo
        ? 'wrong_password'
        : !passwordOk
        ? 'wrong_password'
        : user.disabledAt !== null
          ? 'disabled'
          : undefined;
    if (reason !== undefined || !user) {
      // (already counted by attempt() above)
      logger.warn(
        `login outcome=failure reason=${reason ?? 'unknown_email'}${user ? ` user=${user.id}` : ''} ip=${attempt.ip}`,
      );
      return { kind: 'invalid' };
    }

    // 4. Success. Upgrade an old hash for the same password, without touching password_changed_at.
    if (this.hasher.needsRehash(user.passwordHash)) {
      try {
        await this.users.rehashPassword(user.id, user.passwordHash, await this.hasher.hash(attempt.password));
      } catch {
        logger.warn(`login rehash failed user=${user.id}`); // the login itself still succeeds
      }
    }
    await this.limiter.succeeded(attempt.ip, emailHash);

    // 5. A NEW session, and the old one (if the request carried one) is dead: no session fixation.
    if (attempt.oldToken) await this.sessions.destroy(attempt.oldToken);
    const session = await this.sessions.create(user.id);

    logger.log(`login outcome=success user=${user.id} ip=${attempt.ip}`);
    const { passwordHash: _hash, ...publicUser } = user;
    return { kind: 'success', user: publicUser, session };
  }
}
