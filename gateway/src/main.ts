import { type INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureApp } from './app.setup.js';
import { ConfigValidationError, type AppConfig } from './config/env.schema.js';

/**
 * Closes the app on SIGTERM or SIGINT, then exits. Nest's own enableShutdownHooks() closes the
 * app and then sends the signal to the process again, but in a container node is PID 1, and
 * PID 1 ignores a signal it sends itself: the app closed, yet `docker stop` still waited out
 * its whole timeout and killed it. Exiting explicitly avoids that.
 */
function closeOnSignals(app: INestApplication): void {
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      new Logger('Shutdown').log(`${signal} received, closing`);
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}

async function bootstrap() {
  // Loaded here, not at the top, so a bad setting is caught below with a clear message.
  const { AppModule } = await import('./app.module.js');
  // bodyParser is off here so configureApp can add the JSON parser with its size limit.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  configureApp(app);
  closeOnSignals(app);
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
