import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { AppConfig } from '../config/env.schema.js';
import { SessionService } from '../sessions/session.service.js';
import { clearedSessionCookie, readSessionToken, sessionCookie } from '../sessions/session-cookie.js';
import { JsonContentGuard } from '../tickets/json-content.guard.js';
import { CurrentPrincipal, Public } from './auth.decorators.js';
import { LoginService } from './login.service.js';
import { parseLogin } from './login.schema.js';
import { OriginGuard } from './origin.guard.js';
import type { Principal } from './principal.js';

const logger = new Logger('AuthController');

export const INVALID_LOGIN = 'Invalid email or password';
export const AUTH_UNAVAILABLE = 'Login is temporarily unavailable; please retry';

interface PublicUser {
  id: string;
  email: string;
  display_name: string;
  role: string;
}

/** Reviewer login, logout and "who am I". There is no sign-up: accounts come from the reviewers CLI. */
@Controller('auth')
export class AuthController {
  private readonly secure: boolean;

  constructor(
    @Inject(LoginService) private readonly logins: LoginService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
  ) {
    this.secure = config.get('COOKIE_SECURE', { infer: true });
  }

  /** 200 with the user and a session cookie; 401 {"message":"Invalid email or password"} for every kind of failure. */
  @Post('login')
  @Public()
  @UseGuards(OriginGuard, JsonContentGuard)
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const parsed = parseLogin(body);
    // Not the reason: it could echo what was typed (people type passwords into the email box).
    if (!parsed.ok) throw new BadRequestException({ message: 'Invalid login request' });

    let outcome;
    try {
      outcome = await this.logins.login({
        email: parsed.data.email,
        password: parsed.data.password,
        ip: request.ip ?? request.socket.remoteAddress ?? 'unknown',
        oldToken: readSessionToken(request.headers.cookie),
      });
    } catch (error) {
      throw this.unavailable(error);
    }

    if (outcome.kind === 'limited') {
      response.setHeader('Retry-After', String(outcome.retryAfterSeconds));
      throw new HttpException({ message: 'Too many failed attempts. Try again later.' }, HttpStatus.TOO_MANY_REQUESTS);
    }
    if (outcome.kind === 'invalid') throw new UnauthorizedException({ message: INVALID_LOGIN });

    response.setHeader(
      'Set-Cookie',
      sessionCookie(outcome.session.token, { secure: this.secure, maxAgeSeconds: outcome.session.maxAgeSeconds }),
    );
    return { user: toPublicUser(outcome.user), expires_at: outcome.session.expiresAt.toISOString() };
  }

  /** 204 always: ends the session if there is one and clears the cookie. Logging out twice is fine. */
  @Post('logout')
  @Public()
  @UseGuards(OriginGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response): Promise<void> {
    // The cookie goes first, so it is cleared even if Redis cannot be reached below.
    response.setHeader('Set-Cookie', clearedSessionCookie({ secure: this.secure }));
    const token = readSessionToken(request.headers.cookie);
    if (token === undefined) return;
    try {
      await this.sessions.destroy(token);
    } catch (error) {
      throw this.unavailable(error);
    }
  }

  /** The logged-in reviewer. API-key callers have no session, so for them it is a 401. */
  @Get('me')
  me(@CurrentPrincipal() principal: Principal) {
    if (principal.kind !== 'user') throw new UnauthorizedException({ message: 'Not authenticated' });
    return {
      user: toPublicUser({ id: principal.userId, email: principal.email, displayName: principal.displayName, role: principal.role }),
      expires_at: principal.expiresAt.toISOString(),
    };
  }

  private unavailable(error: unknown): Error {
    if (error instanceof HttpException) return error;
    logger.warn(`Auth call failed (${(error as NodeJS.ErrnoException).code ?? (error as Error).name})`);
    return new ServiceUnavailableException({ message: AUTH_UNAVAILABLE });
  }
}

function toPublicUser(user: { id: string; email: string; displayName: string; role: string }): PublicUser {
  return { id: user.id, email: user.email, display_name: user.displayName, role: user.role };
}
