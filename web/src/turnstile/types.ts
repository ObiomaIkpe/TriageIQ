/** What the form needs from the Cloudflare Turnstile widget. The form knows only this, so tests can fake it. */
export interface TurnstileHandlers {
  /** A fresh, single-use token. */
  onToken: (token: string) => void;
  /** The token timed out before it was used. */
  onExpired: () => void;
  /** The widget itself failed (network, blocked, bad configuration). */
  onError: () => void;
}

export interface TurnstileWidget {
  /** Asks for a new token (every token works once, so call it after any failed submit). */
  reset: () => void;
  /** Takes the widget out of the page for good. Safe to call twice. */
  remove: () => void;
}

/**
 * Puts a widget in `container`. Rejects if the Turnstile script cannot be loaded, or with an AbortError if `signal` was
 * aborted first (the caller went away: nothing is rendered then). The widget is rendered only after the script is ready AND
 * the signal is still live, in one synchronous step, so two calls for one container (React StrictMode mounts, unmounts and
 * mounts again in development) can never both render.
 */
export type TurnstileLoader = (container: HTMLElement, handlers: TurnstileHandlers, signal: AbortSignal) => Promise<TurnstileWidget>;
