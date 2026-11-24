import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/env.schema.js';
import { UsersRepository } from '../users/users.repository.js';
import type { User } from '../users/user.types.js';
import { DEMO_DISPLAY_NAME, DEMO_EMAIL, DEMO_PASSWORD_HASH } from './demo.constants.js';

const logger = new Logger('Demo');

/** Keeps the one shared demo user in existence while DEMO_MODE is on. With it off, nothing is created and nothing happens. */
@Injectable()
export class DemoService implements OnApplicationBootstrap {
  private readonly enabled: boolean;

  constructor(
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
    @Inject(UsersRepository) private readonly users: UsersRepository,
  ) {
    this.enabled = config.get('DEMO_MODE', { infer: true });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.ensureUser();
      logger.log('demo mode is ON: the shared demo user is in place');
    } catch (error) {
      // Not fatal: the first demo login makes it again. (The database was reachable a moment ago: migrations just ran.)
      logger.error(`Could not create the demo user at startup (${(error as { code?: string }).code ?? (error as Error).name}); it will be tried again at the first demo login`);
    }
  }

  /** The demo user, created if missing. Never changes an existing row. */
  ensureUser(): Promise<User> {
    return this.users.ensureDemoUser(DEMO_EMAIL, DEMO_DISPLAY_NAME, DEMO_PASSWORD_HASH);
  }
}
