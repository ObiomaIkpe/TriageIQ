import {
  ApiError,
  ConflictError,
  ForbiddenError,
  NetworkError,
  RateLimitedError,
  ServerError,
  UnauthorizedError,
  ValidationError,
  type FieldProblem,
} from './errors.js';

/**
 * The UI calls the API ONLY under /api/... (a proxy forwards it to the gateway and removes the prefix), so the
 * browser stays on one origin: the session cookie is same-origin and no CORS is needed. UI routes never start with /api.
 */
export const API_PREFIX = '/api';

type Handler = () => void;
let onUnauthorized: Handler | undefined;

/** The app registers what happens when a later API call answers 401 (the session ended). */
export function setUnauthorizedHandler(handler: Handler | undefined): void {
  onUnauthorized = handler;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Extra request headers (for example Idempotency-Key). */
  headers?: Record<string, string>;
  /**
   * Whether a 401 means "the session ended" (the default). The login call and the "who am I" probe set this to
   * false: a 401 there is an ordinary answer, not an event.
   */
  sessionEndsOn401?: boolean;
}

/** Seconds from a Retry-After header ("120"), or undefined. (An HTTP date is not used by the gateway.) */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  return Number(value.trim());
}

/**
 * The one fetch wrapper. Same-origin cookies only (credentials 'same-origin'), JSON in and JSON out, no
 * Authorization header and nothing stored in the browser. Failures become typed errors.
 */
export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, sessionEndsOn401 = true } = options;
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new NetworkError();
  }

  if (response.ok) {
    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch {
      throw new ServerError(response.status); // a 2xx that is not JSON is the server's fault
    }
  }

  if (response.status === 401) {
    if (sessionEndsOn401) onUnauthorized?.();
    throw new UnauthorizedError();
  }
  if (response.status === 400) throw new ValidationError(await readFieldProblems(response));
  if (response.status === 403) throw new ForbiddenError();
  if (response.status === 409) throw new ConflictError();
  if (response.status === 429) throw new RateLimitedError(parseRetryAfter(response.headers.get('Retry-After')));
  if (response.status >= 500) throw new ServerError(response.status);
  throw new ApiError('Request failed', response.status);
}

/** The {field, problem} list of a 400 body, or [] if the body is not in that shape. Only strings are kept. */
async function readFieldProblems(response: Response): Promise<FieldProblem[]> {
  try {
    const body = (await response.json()) as { errors?: unknown };
    if (!Array.isArray(body.errors)) return [];
    return body.errors
      .filter((e): e is FieldProblem => typeof e === 'object' && e !== null && typeof (e as FieldProblem).field === 'string' && typeof (e as FieldProblem).problem === 'string')
      .map((e) => ({ field: e.field, problem: e.problem }));
  } catch {
    return [];
  }
}
