import type { TurnstileLoader } from './types.js';

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const SCRIPT_SELECTOR = 'script[src^="https://challenges.cloudflare.com/turnstile/v0/api.js"]';
export const ACTION = 'public_ticket';

interface TurnstileApi {
  render: (container: HTMLElement, options: Record<string, unknown>) => string | undefined;
  reset: (id: string) => void;
  remove: (id: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | undefined;

/**
 * Loads Cloudflare's script exactly once per page (a shared promise), and only when the form page asks. An existing
 * <script> tag (from a hot reload, or another call) is reused, never a second one added: loading api.js twice makes
 * Turnstile reject renders.
 */
function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.querySelector<HTMLScriptElement>(SCRIPT_SELECTOR) ?? Object.assign(document.createElement('script'), { src: SCRIPT_URL, async: true });
    const done = () => (window.turnstile ? resolve(window.turnstile) : fail());
    const fail = () => {
      loading = undefined; // allow a later try
      script.remove();
      reject(new Error('turnstile script failed'));
    };
    script.addEventListener('load', done, { once: true });
    script.addEventListener('error', fail, { once: true });
    if (!script.isConnected) document.head.appendChild(script);
  });
  return loading;
}

/** For tests: forget the shared script promise. */
export function resetTurnstileScriptForTests(): void {
  loading = undefined;
}

/** The widget id of each container that has one, so a container never gets a second widget on top of the first. */
const live = new WeakMap<HTMLElement, string>();

/** The real widget: explicit rendering, the site key from VITE_TURNSTILE_SITE_KEY, action "public_ticket". */
export const realTurnstile: TurnstileLoader = async (container, handlers, signal) => {
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
  if (!siteKey) throw new Error('VITE_TURNSTILE_SITE_KEY is not set');
  const api = await loadScript();
  // Everything from here to the end is synchronous: nothing can interleave between this check and the render.
  if (signal.aborted) throw new DOMException('Turnstile render aborted', 'AbortError');

  const stale = live.get(container);
  if (stale !== undefined) {
    api.remove(stale);
    live.delete(container);
  }
  container.replaceChildren(); // render only into an empty container

  const id = api.render(container, {
    sitekey: siteKey,
    action: ACTION,
    callback: handlers.onToken,
    'expired-callback': handlers.onExpired,
    'error-callback': () => {
      handlers.onError();
      return true; // we show our own message
    },
  });
  if (id === undefined) throw new Error('turnstile render was refused');
  live.set(container, id);

  let current: string | undefined = id;
  return {
    reset: () => {
      if (current !== undefined) api.reset(current);
    },
    remove: () => {
      if (current === undefined) return;
      api.remove(current);
      if (live.get(container) === current) live.delete(container);
      current = undefined; // the id is cleared: a later reset or remove does nothing
    },
  };
};
