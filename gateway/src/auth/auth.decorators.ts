import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { Role } from './auth.types.js';
import type { Principal } from './principal.js';

export const IS_PUBLIC = 'auth:isPublic';
export const ROLES_KEY = 'auth:roles';

/** Marks a route (or a whole controller) as open to everyone: no key, no rate limit. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Limits a route (or controller) to these roles. Without it any authenticated client may call it. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** A request after the auth guard ran. Not `client`: Node already uses that name for the socket. */
export type AuthedRequest = Request & { principal?: Principal };

/** Who is calling (a client or a logged-in user), as the auth guard attached it to the request. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal | undefined =>
    context.switchToHttp().getRequest<AuthedRequest>().principal,
);
