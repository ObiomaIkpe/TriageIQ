import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ConfigValidationError, type AppConfig } from './config/env.schema.js';

async function bootstrap() {
  // Loaded here, not at the top, so a bad setting is caught below with a clear message.
  const { AppModule } = await import('./app.module.js');
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const config = app.get<ConfigService<AppConfig, true>>(ConfigService);
  await app.listen(config.get('PORT', { infer: true }));
}

bootstrap().catch((error: unknown) => {
  if (error instanceof ConfigValidationError) {
    console.error(error.message);
  } else {
    console.error(`Gateway failed to start (${(error as Error)?.name ?? 'Error'}).`);
  }
  process.exit(1);
});
