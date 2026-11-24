import { type CanActivate, type ExecutionContext, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { SetMetadata } from '@nestjs/common';
import type { AppConfig } from '../config/env.schema.js';

export const DEMO_ONLY = 'demo:only';

/** Marks a route as part of the demo room: it exists (answers) only when DEMO_MODE=true, and is a plain 404 otherwise. */
export const DemoOnly = () => SetMetadata(DEMO_ONLY, true);

/**
 * A GLOBAL guard that runs BEFORE authentication, so that with DEMO_MODE=false a demo route is a 404 for everyone: with no
 * login (not a 401), with a real reviewer's session (not a 403), and with an API key. The routes do not exist.
 */
@Injectable()
export class DemoOnlyGuard implements CanActivate {
  private readonly enabled: boolean;

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
  ) {
    this.enabled = config.get('DEMO_MODE', { infer: true });
  }

  canActivate(context: ExecutionContext): boolean {
    const demoOnly = this.reflector.getAllAndOverride<boolean>(DEMO_ONLY, [context.getHandler(), context.getClass()]);
    if (!demoOnly || this.enabled) return true;
    throw new NotFoundException({ message: 'Not Found' });
  }
}
