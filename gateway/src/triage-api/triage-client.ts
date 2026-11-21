import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/env.schema.js';
import { FETCH } from '../health/health.constants.js';
import {
  MSG_ERROR,
  MSG_REJECTED,
  MSG_UNAVAILABLE,
  TRIAGE_API_TIMEOUTS,
  type TriageApiTimeouts,
} from './triage-api.constants.js';

const logger = new Logger('TriagePassthrough');

/** What one call to the Python service may ask for. */
export interface TriageCall {
  method: 'GET' | 'POST';
  /** A path already checked by the caller, such as /tickets/<uuid>. */
  path: string;
  /** Only the query parameters the caller has validated. */
  query?: Record<string, string>;
  /** A body already validated by the caller. Sent as JSON. */
  body?: unknown;
  kind: 'read' | 'review';
  /** For the log line only: the route as a fixed label, such as "GET /tickets/:id". */
  route: string;
  /** For the log line only: the API client's name. */
  client: string;
  /** For the log line only: the namespaced id of the reviewer a review is recorded as. Never a name or email. */
  reviewer?: string;
}

/** A Python answer that is passed on to the caller as it is. */
export interface TriageAnswer {
  status: number;
  body: unknown;
}

/** Statuses whose JSON body is the real answer and is passed through. */
function isPassedThrough(status: number): boolean {
  return (status >= 200 && status < 300) || [400, 404, 409, 422].includes(status);
}

/**
 * Calls the Python service on behalf of a reviewer. Each call is a NEW request built here:
 * nothing from the client's own request (its Authorization header or any other header) is
 * copied, and the only credential sent is the gateway's own review key.
 *
 * Python's answers are mapped so that no internal detail reaches the client:
 *  - 2xx, 400, 404, 409, 422: the status and JSON body pass through
 *  - 401, or the 503 that means "review key not set": the gateway is misconfigured -> 502
 *  - any other 503 (database or Claude trouble, "please retry"), a timeout, no connection -> 503
 *  - any other status, or an unreadable body -> 502
 */
@Injectable()
export class TriageClient {
  private readonly baseUrl: string;
  private readonly reviewKey: string;

  constructor(
    @Inject(ConfigService) config: ConfigService<AppConfig, true>,
    @Inject(FETCH) private readonly fetchFn: typeof fetch,
    @Inject(TRIAGE_API_TIMEOUTS) private readonly timeouts: TriageApiTimeouts,
  ) {
    this.baseUrl = config.get('TRIAGE_SERVICE_URL', { infer: true }).replace(/\/+$/, '');
    this.reviewKey = config.get('TRIAGE_REVIEW_API_KEY', { infer: true });
  }

  async call(call: TriageCall): Promise<TriageAnswer> {
    const started = Date.now();
    const query = new URLSearchParams(call.query ?? {}).toString();
    const url = `${this.baseUrl}${call.path}${query ? `?${query}` : ''}`;
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-api-key': this.reviewKey,
    };
    if (call.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: call.method,
        headers,
        body: call.body === undefined ? undefined : JSON.stringify(call.body),
        // Never follow a redirect: it would carry the review key somewhere else.
        redirect: 'manual',
        signal: AbortSignal.timeout(call.kind === 'review' ? this.timeouts.reviewMs : this.timeouts.readMs),
      });
    } catch {
      // A timeout, a refused or reset connection, DNS: all "try again later". The error is not
      // logged or returned, since it can contain the internal URL.
      this.log(call, 'unreachable', started);
      throw new ServiceUnavailableException({ detail: MSG_UNAVAILABLE });
    }

    const status = response.status;
    this.log(call, status, started);

    let body: unknown;
    try {
      const text = await response.text();
      body = text === '' ? undefined : (JSON.parse(text) as unknown);
    } catch {
      body = undefined; // not JSON (or the read failed): decided below
    }

    if (status === 401 || (status === 503 && isReviewDisabled(body))) {
      logger.warn(
        `Python rejected the gateway's review key or has none (${status}) on ${call.route}: ` +
          'check TRIAGE_REVIEW_API_KEY against REVIEW_API_KEY',
      );
      throw new BadGatewayException({ detail: MSG_REJECTED });
    }
    if (status === 503) throw new ServiceUnavailableException({ detail: MSG_UNAVAILABLE });
    if (isPassedThrough(status) && body !== undefined) return { status, body };
    throw new BadGatewayException({ detail: MSG_ERROR });
  }

  /** One line per call: who, which route, what Python answered, how long. Never ticket text or keys. */
  private log(call: TriageCall, result: number | 'unreachable', started: number): void {
    const reviewer = call.reviewer === undefined ? '' : ` reviewer=${call.reviewer}`;
    const line = `client=${call.client} route="${call.route}"${reviewer} python_status=${result} duration_ms=${Date.now() - started}`;
    if (result === 'unreachable' || result >= 500) logger.warn(line);
    else logger.log(line);
  }
}

/** Python's 503 for a missing review key says so in its detail. Other 503s are retryable. */
function isReviewDisabled(body: unknown): boolean {
  const detail = (body as { detail?: unknown } | undefined)?.detail;
  return typeof detail === 'string' && detail.startsWith('Review is disabled');
}
