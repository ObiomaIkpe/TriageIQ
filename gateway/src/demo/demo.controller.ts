import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
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
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { Public, Roles } from '../auth/auth.decorators.js';
import { OriginGuard } from '../auth/origin.guard.js';
import type { AppConfig } from '../config/env.schema.js';
import { IDEMPOTENCY_HEADER, parseIdempotencyKey } from '../idempotency/idempotency-key.js';
import { MSG_ACCEPTED, MSG_DAILY_CAP, MSG_RATE_LIMITED, MSG_TURNSTILE_UNAVAILABLE, MSG_VERIFICATION_FAILED, PUBLIC_IP_WINDOW_SECONDS, PUBLIC_STORE } from '../public-tickets/public.constants.js';
import type { PublicStore } from '../public-tickets/public-store.js';
import { SessionService } from '../sessions/session.service.js';
import { clearedSessionCookie, readSessionToken, sessionCookie } from '../sessions/session-cookie.js';
import { JsonContentGuard } from '../tickets/json-content.guard.js';
import { DemoOnly } from './demo-only.js';
import { DEMO_LOGIN_IP_PREFIX, DEMO_SESSION_SECONDS } from './demo.constants.js';
import { DemoService } from './demo.service.js';
import { DemoIntakeService } from './demo-intake.service.js';
import { parseDemoTicket } from './demo-ticket.schema.js';

const logger = new Logger('DemoController');
const DEMO_LOGIN_UNAVAILABLE = 'The demo is temporarily unavailable; please retry';
const MSG_DEMO_LOGIN_LIMITED = 'Too many demo logins from your network. Please try again later.';

/**
 * The demo room's three routes. Every one is @DemoOnly(): with DEMO_MODE=false each is a plain 404 (a global guard, before login).
 *   GET  /demo/status      is the demo on? (the login page asks, to decide whether to show the button)
 *   POST /auth/demo-login  a session for the shared demo user, valid for ONE hour. No body, no password.
 *   POST /demo/tickets     a visitor's own test ticket (a real triage run, as a demo ticket). Demo sessions only.
 */
@Controller()
export class DemoController {
  private readonly secure: boolean;
  private readonly loginMaxPerIp: number;

  constructor(
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
    @Inject(DemoService) private readonly demo: DemoService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(PUBLIC_STORE) private readonly store: PublicStore,
    @Inject(DemoIntakeService) private readonly intake: DemoIntakeService,
  ) {
    this.secure = config.get('COOKIE_SECURE', { infer: true });
    this.loginMaxPerIp = config.get('DEMO_LOGIN_MAX_PER_IP_PER_HOUR', { infer: true });
  }

  @Get('demo/status')
  @Public()
  @DemoOnly()
  status() {
    return { enabled: true };
  }

  /**
   * Origin-checked (like login), counted per client IP, and it never touches the failed-login limiter (there is no password to
   * fail): the demo account cannot be locked by anyone's attempts. A demo user that an operator DISABLED stays out.
   */
  @Post('auth/demo-login')
  @Public()
  @DemoOnly()
  @UseGuards(OriginGuard)
  @HttpCode(HttpStatus.OK)
  async login(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    try {
      const hit = await this.store.hitIp(ip, PUBLIC_IP_WINDOW_SECONDS, DEMO_LOGIN_IP_PREFIX);
      if (hit.count > this.loginMaxPerIp) {
        response.setHeader('Retry-After', String(Math.max(1, hit.ttlSeconds)));
        logger.warn(`demo_login outcome=rate_limited ip=${ip}`);
        throw new HttpException({ message: MSG_DEMO_LOGIN_LIMITED }, HttpStatus.TOO_MANY_REQUESTS);
      }
      const user = await this.demo.ensureUser();
      if (user.role !== 'demo' || user.disabledAt !== null) {
        logger.warn(`demo_login outcome=refused reason=${user.disabledAt === null ? 'role' : 'disabled'}`);
        throw new UnauthorizedException({ message: 'The demo is not available' });
      }
      // A new session replaces any the browser carried (no session fixation), exactly as the real login does.
      const old = readSessionToken(request.headers.cookie);
      if (old) await this.sessions.destroy(old);
      const session = await this.sessions.create(user.id, { absoluteSeconds: DEMO_SESSION_SECONDS });
      response.setHeader('Set-Cookie', sessionCookie(session.token, { secure: this.secure, maxAgeSeconds: session.maxAgeSeconds }));
      logger.log(`demo_login outcome=success ip=${ip}`);
      return {
        user: { id: user.id, email: user.email, display_name: user.displayName, role: user.role },
        expires_at: session.expiresAt.toISOString(),
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      logger.warn(`demo_login outcome=unavailable (${(error as NodeJS.ErrnoException).code ?? (error as Error).name})`);
      response.setHeader('Set-Cookie', clearedSessionCookie({ secure: this.secure }));
      throw new ServiceUnavailableException({ message: DEMO_LOGIN_UNAVAILABLE });
    }
  }

  @Post('demo/tickets')
  @DemoOnly()
  @Roles('demo')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(JsonContentGuard)
  async create(
    @Body() body: unknown,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
  ) {
    const key = parseIdempotencyKey(idempotencyKey);
    if (key.ok && key.key === undefined) {
      throw new BadRequestException({ message: 'Please check the form and try again.', errors: [{ field: IDEMPOTENCY_HEADER, problem: 'is required' }] });
    }
    if (!key.ok) throw new BadRequestException({ message: 'Please check the form and try again.', errors: key.problems });
    const parsed = parseDemoTicket(body);
    if (!parsed.ok) throw new BadRequestException({ message: 'Please check the form and try again.', errors: parsed.problems });

    const ip = request.ip ?? request.socket.remoteAddress ?? 'unknown';
    const outcome = await this.intake.accept(parsed.data, key.key as string, ip);
    switch (outcome.kind) {
      case 'accepted':
      case 'honeypot':
        return { reference: outcome.reference, message: MSG_ACCEPTED };
      case 'replay':
        response.setHeader('Idempotent-Replayed', 'true');
        return { reference: outcome.reference, message: MSG_ACCEPTED };
      case 'rate_limited_ip':
        response.setHeader('Retry-After', String(outcome.retryAfterSeconds));
        throw new HttpException({ message: MSG_RATE_LIMITED }, HttpStatus.TOO_MANY_REQUESTS);
      case 'turnstile_failed':
        throw new ForbiddenException({ message: MSG_VERIFICATION_FAILED });
      case 'turnstile_unavailable':
      case 'unavailable':
        throw new ServiceUnavailableException({ message: MSG_TURNSTILE_UNAVAILABLE });
      case 'daily_cap':
        response.setHeader('Retry-After', String(outcome.retryAfterSeconds));
        throw new ServiceUnavailableException({ message: MSG_DAILY_CAP });
      case 'conflict':
        throw new UnprocessableEntityException({ message: 'This request key was already used with a different message.' });
    }
  }
}
