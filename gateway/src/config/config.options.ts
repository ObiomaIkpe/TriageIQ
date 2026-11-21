import type { ConfigModuleOptions } from '@nestjs/config';
import { validateEnv } from './env.schema.js';

/**
 * The options AppModule passes to ConfigModule.forRoot. `validate` runs inside forRoot,
 * so a bad setting throws before the server is created.
 */
export const configModuleOptions: ConfigModuleOptions = {
  isGlobal: true,
  validate: validateEnv,
};
