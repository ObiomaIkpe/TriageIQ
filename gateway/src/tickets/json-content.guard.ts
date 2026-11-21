import { type CanActivate, type ExecutionContext, HttpException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

/** Only application/json requests may reach the handler. Anything else is a 415. */
@Injectable()
export class JsonContentGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.is('application/json')) {
      throw new HttpException({ detail: 'Content-Type must be application/json' }, 415);
    }
    return true;
  }
}
