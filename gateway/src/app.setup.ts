import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ErrorRequestHandler } from 'express';

/** JSON bodies larger than this get a 413 before they are parsed. */
export const BODY_LIMIT = '100kb';

/**
 * Turns body-parser failures into JSON answers. Without this, Express would send an
 * HTML page, and a bad JSON body's error text can quote part of what was sent.
 */
export const bodyErrorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  const { type, status } = error as { type?: string; status?: number };
  if (type === 'entity.too.large') {
    response.status(413).json({ detail: 'Request body too large (limit 100 kb)' });
  } else if (type === 'entity.parse.failed') {
    response.status(400).json({ detail: 'Request body is not valid JSON' });
  } else if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
    response.status(415).json({ detail: 'Unsupported content encoding' });
  } else if (typeof status === 'number' && status >= 400 && status < 500) {
    response.status(status).json({ detail: 'Bad request' });
  } else {
    next(error);
  }
};

/**
 * Settings shared by the real app (main.ts) and the tests, so both behave the same.
 * Create the app with `{ bodyParser: false }`: the JSON parser is added here, with the
 * size limit, followed by the handler for its errors (order matters).
 */
export function configureApp(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.use(bodyErrorHandler);
  app.enableShutdownHooks();
}
