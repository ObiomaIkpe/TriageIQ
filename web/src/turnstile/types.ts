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
  remove: () => void;
}

/** Puts a widget in `container`. Rejects if the Turnstile script cannot be loaded. */
export type TurnstileLoader = (container: HTMLElement, handlers: TurnstileHandlers) => Promise<TurnstileWidget>;
