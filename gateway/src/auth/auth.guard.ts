import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { AppConfig } from '../config/env.schema.js';
import { SessionAuthenticator } from '../sessions/session-authenticator.js';
import { readSessionToken } from '../sessions/session-cookie.js';
import { extractBearerKey, findClient } from './api-key.js';
import { type AuthedRequest, IS_PUBLIC } from './auth.decorators.js';
import { isSafeMethod, originAllowed } from './origin.js';
import { clientPrincipal } from './principal.js';

export const INVALID_KEY = 'Missing or invalid API key';
export const SESSIONS_UNAVAILABLE = 'Sessions are temporarily unavailable; please retry';

const logger = new Logger('Auth');

/**
 * Global guard: every route needs a credential unless it is marked @Public(). Two kinds of caller:
 *  - a machine client: "Authorization: Bearer <key>". If that header is present, ONLY the key is
 *    considered; a cookie sent with it is ignored, so a request can never be half one and half the other;
 *  - a logged-in reviewer: the session cookie, when there is no Authorization header. A write made
 *    with a cookie (anything but GET/HEAD/OPTIONS) must also carry an allowed Origin (403 otherwise);
 *    key requests are exempt, since no cookie is involved.
 * Either way the result is one Principal on the request. Nothing secret is logged or echoed.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly clients;
  private readonly allowedOrigins: string[];

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
    @Inject(SessionAuthenticator) private readonly sessions: SessionAuthenticator,
  ) {
    this.clients = config.get('GATEWAY_CLIENTS', { infer: true });
    this.allowedOrigins = config.get('ALLOWED_ORIGINS', { infer: true });
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const http = context.switchToHttp();
    const request = http.getRequest<AuthedRequest>();
    const refuse = (): never => {
      http.getResponse<Response>().setHeader('WWW-Authenticate', 'Bearer');
      // The /auth endpoints speak to a browser, so their errors use "message"; the rest keep "detail".
      throw new UnauthorizedException(
        request.path.startsWith('/auth/') ? { message: 'Not authenticated' } : { detail: INVALID_KEY },
      );
    };

    // A machine client: the key alone decides.
    if (request.headers.authorization !== undefined) {
      const key = extractBearerKey(request.headers.authorization);
      const client = key === undefined ? undefined : findClient(this.clients, key);
      if (!client) return refuse();
      request.principal = clientPrincipal(client.name, client.role);
      return true;
    }

    // A reviewer's session cookie.
    const token = readSessionToken(request.headers.cookie);
    if (token === undefined) return refuse();
    if (!isSafeMethod(request.method) && !originAllowed(request, this.allowedOrigins)) {
      throw new ForbiddenException(
        request.path.startsWith('/auth/') ? { message: 'Origin not allowed' } : { detail: 'Origin not allowed' },
      );
    }
    let principal;
    try {
      principal = await this.sessions.authenticate(token);
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // Redis or Postgres trouble: fail closed, and say nothing about it beyond a short code.
      logger.warn(`Session check failed (${(error as NodeJS.ErrnoException).code ?? (error as Error).name})`);
      throw new ServiceUnavailableException({ detail: SESSIONS_UNAVAILABLE });
    }
    if (!principal) return refuse();
    request.principal = principal;
    return true;
  }
}
