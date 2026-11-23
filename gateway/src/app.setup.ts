import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { ErrorRequestHandler } from 'express';
import { json } from 'express';
import helmet from 'helmet';
import { PUBLIC_BODY_LIMIT } from './public-tickets/public.constants.js';

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
  // Behind a proxy you control (TRUST_PROXY=true) the client IP comes from X-Forwarded-For; otherwise it is
  // the socket address. Login failure limits use it, so trusting a header nobody controls would let a caller
  // pick its own IP: this is off unless asked for. "true" trusts exactly ONE hop (the reverse proxy, Caddy in
  // production): the client is the LAST address in X-Forwarded-For, the one that proxy appended. Anything a caller
  // put before it is ignored. (Express's `true` would trust every hop and believe the first, spoofable, entry.)
  if (app.get(ConfigService).get<boolean>('TRUST_PROXY') === true) app.set('trust proxy', 1);
  // First, so every response (errors and 401s included) carries the security headers.
  // helmet's defaults also remove X-Powered-By.
  app.use(helmet());
  // The public form is open to the internet, so its body limit is much smaller (a ticket is a few KB at most).
  // This parser runs first for that path and leaves nothing for the general one; too large is a 413 from the same handler.
  app.use('/public', json({ limit: PUBLIC_BODY_LIMIT }));
  app.useBodyParser('json', { limit: BODY_LIMIT });
  app.use(bodyErrorHandler);
}
