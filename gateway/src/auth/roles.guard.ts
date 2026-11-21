import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { type AuthedRequest, IS_PUBLIC, ROLES_KEY } from './auth.decorators.js';
import type { Role } from './auth.types.js';

/**
 * Global guard, after the auth guard: a route marked @Roles(...) is only for those roles.
 * A route without @Roles is open to every authenticated client. Wrong role -> 403.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets);
    if (!roles || roles.length === 0) return true;
    const principal = context.switchToHttp().getRequest<AuthedRequest>().principal;
    if (!principal || !roles.includes(principal.role)) {
      throw new ForbiddenException({ detail: 'Not allowed' });
    }
    return true;
  }
}
