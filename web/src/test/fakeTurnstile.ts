import type { TurnstileHandlers, TurnstileLoader } from '../turnstile/types.js';

/** A stand-in for Cloudflare's widget: the test decides when a token, an expiry or an error arrives. */
export function fakeTurnstile(options: { failToLoad?: boolean } = {}) {
  const state = {
    handlers: undefined as TurnstileHandlers | undefined,
    renders: 0,
    resets: 0,
    removes: 0,
    failToLoad: options.failToLoad ?? false,
  };
  const loader: TurnstileLoader = async (_container, handlers) => {
    if (state.failToLoad) throw new Error('script failed');
    state.handlers = handlers;
    state.renders += 1;
    return { reset: () => (state.resets += 1), remove: () => (state.removes += 1) };
  };
  return {
    loader,
    state,
    token: (value = 'tok-1') => state.handlers?.onToken(value),
    expire: () => state.handlers?.onExpired(),
    fail: () => state.handlers?.onError(),
  };
}
