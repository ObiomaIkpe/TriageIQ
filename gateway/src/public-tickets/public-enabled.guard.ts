import { type CanActivate, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/env.schema.js';

/** The public form does not exist (404, like an unknown route) unless PUBLIC_FORM_ENABLED=true. */
@Injectable()
export class PublicEnabledGuard implements CanActivate {
  private readonly enabled: boolean;

  constructor(@Inject(ConfigService) config: ConfigService<AppConfig, true>) {
    this.enabled = config.get('PUBLIC_FORM_ENABLED', { infer: true });
  }

  canActivate(): boolean {
    if (this.enabled) return true;
    throw new NotFoundException({ message: 'Not Found' });
  }
}
