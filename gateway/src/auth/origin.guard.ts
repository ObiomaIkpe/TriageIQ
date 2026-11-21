import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type { AppConfig } from '../config/env.schema.js';
import { isSafeMethod, originAllowed } from './origin.js';

export const ORIGIN_REFUSED = 'Origin not allowed';

/**
 * Route-level guard for POST /auth/login and /auth/logout (public routes the global guards skip):
 * anything but GET/HEAD/OPTIONS must carry an Origin that exactly matches ALLOWED_ORIGINS, else 403.
 */
@Injectable()
export class OriginGuard implements CanActivate {
  private readonly allowed: string[];

  constructor(@Inject(ConfigService) config: ConfigService<AppConfig, true>) {
    this.allowed = config.get('ALLOWED_ORIGINS', { infer: true });
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (isSafeMethod(request.method) || originAllowed(request, this.allowed)) return true;
    throw new ForbiddenException({ message: ORIGIN_REFUSED });
  }
}
