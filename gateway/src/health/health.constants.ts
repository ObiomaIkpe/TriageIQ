/** Injection token for the fetch function used to call the Python service. */
export const FETCH = Symbol('FETCH');
/** Injection token for the per-check timeout, in milliseconds. */
export const READY_TIMEOUT_MS = Symbol('READY_TIMEOUT_MS');
/** How long /ready waits for each dependency. */
export const DEFAULT_READY_TIMEOUT_MS = 1500;
