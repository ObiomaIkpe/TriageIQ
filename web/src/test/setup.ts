import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { setUnauthorizedHandler } from '../api/client.js';
import { server } from './server.js';

beforeAll(() => {
  // "error": a call the test did not expect is a failure, not a silent network call.
  server.listen({ onUnhandledFrame: 'error' });
  // Node's fetch needs absolute URLs; the browser resolves "/api/..." against the page. Do the same here.
  const patched = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    patched(typeof input === 'string' && input.startsWith('/') ? new URL(input, window.location.origin) : input, init)) as typeof fetch;
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
  setUnauthorizedHandler(undefined);
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterAll(() => server.close());
