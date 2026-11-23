import type { TurnstileHandlers, TurnstileLoader } from '../turnstile/types.js';

/**
 * A stand-in for Cloudflare's widget. It behaves like the real one where it matters: the "script" takes a moment to load,
 * and a second render into a container that already holds a widget is REFUSED ("already been rendered in this container").
 * The test decides when a token, an expiry or an error arrives.
 */
export function fakeTurnstile(options: { failToLoad?: boolean } = {}) {
  const state = {
    handlers: undefined as TurnstileHandlers | undefined,
    /** How many times the loader was called. */
    calls: 0,
    /** Successful renders. */
    renders: 0,
    /** Renders refused because the container already had a widget (must stay 0). */
    refused: 0,
    resets: 0,
    removes: 0,
    /** Widgets on the page right now. */
    live: 0,
    failToLoad: options.failToLoad ?? false,
  };
  const occupied = new WeakSet<HTMLElement>();
  // ONE script load that every pending call waits on, like the real loader's shared promise: when it finishes, all waiting
  // calls continue in the same tick, back to back (this is what makes React StrictMode's double mount race in a real page).
  let script: Promise<void> | undefined;
  const scriptReady = () => (script ??= new Promise<void>((resolve) => setTimeout(resolve, 5)));

  const loader: TurnstileLoader = async (container, handlers, signal) => {
    state.calls += 1;
    await scriptReady(); // the script is not there yet
    if (state.failToLoad) throw new Error('script failed');
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    if (occupied.has(container)) {
      state.refused += 1;
      throw new Error('Turnstile has already been rendered in this container');
    }
    occupied.add(container);
    state.handlers = handlers;
    state.renders += 1;
    state.live += 1;
    let removed = false;
    return {
      reset: () => {
        if (!removed) state.resets += 1;
      },
      remove: () => {
        if (removed) return;
        removed = true;
        occupied.delete(container);
        state.removes += 1;
        state.live -= 1;
      },
    };
  };
  return {
    loader,
    state,
    token: (value = 'tok-1') => state.handlers?.onToken(value),
    expire: () => state.handlers?.onExpired(),
    fail: () => state.handlers?.onError(),
  };
}
