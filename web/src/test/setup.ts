import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { setUnauthorizedHandler } from '../api/client.js';
import { server } from './server.js';

// Testing Library waits up to 1 s by default for something to appear. A busy shared CI runner can need longer; a test that
// is going to pass should not fail for being slow (a test that should fail still fails, just after 5 s).
configure({ asyncUtilTimeout: 5000 });

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
