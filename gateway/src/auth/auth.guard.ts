import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { AppConfig } from '../config/env.schema.js';
import { extractBearerKey, findClient } from './api-key.js';
import { type AuthedRequest, IS_PUBLIC } from './auth.decorators.js';

export const INVALID_KEY = 'Missing or invalid API key';

/**
 * Global guard: every route needs "Authorization: Bearer <key>" unless it is marked @Public().
 * The key is hashed and compared with the registered hashes. A missing, malformed or unknown
 * key gets 401 and "WWW-Authenticate: Bearer". The key is never logged or echoed.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly clients;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
  ) {
    this.clients = config.get('GATEWAY_CLIENTS', { infer: true });
  }

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const http = context.switchToHttp();
    const request = http.getRequest<AuthedRequest>();
    const key = extractBearerKey(request.headers.authorization);
    const client = key === undefined ? undefined : findClient(this.clients, key);
    if (!client) {
      http.getResponse<Response>().setHeader('WWW-Authenticate', 'Bearer');
      throw new UnauthorizedException({ detail: INVALID_KEY });
    }
    request.apiClient = { name: client.name, role: client.role };
    return true;
  }
}
