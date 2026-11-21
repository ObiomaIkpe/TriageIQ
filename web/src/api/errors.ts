/** What went wrong with an API call, as a type the UI can switch on. Messages never carry server text. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** 401: no session, or it ended. */
export class UnauthorizedError extends ApiError {
  constructor() {
    super('Unauthorized', 401);
  }
}

/** 403: refused (for example the gateway's Origin check). */
export class ForbiddenError extends ApiError {
  constructor() {
    super('Forbidden', 403);
  }
}

/** 429: too many attempts. `retryAfterSeconds` comes from the Retry-After header (undefined if it was missing or unusable). */
export class RateLimitedError extends ApiError {
  constructor(readonly retryAfterSeconds?: number) {
    super('Rate limited', 429);
  }
}

/** 5xx. */
export class ServerError extends ApiError {
  constructor(status: number) {
    super('Server error', status);
  }
}

/** The request never got an answer (offline, refused, the proxy has no upstream). */
export class NetworkError extends ApiError {
  constructor() {
    super('Network error');
  }
}
