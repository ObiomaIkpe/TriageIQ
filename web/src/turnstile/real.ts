import type { TurnstileLoader } from './types.js';

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
export const ACTION = 'public_ticket';

interface TurnstileApi {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  reset: (id: string) => void;
  remove: (id: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | undefined;

/** Loads Cloudflare's script once, on demand: only the public form page ever calls this. */
function loadScript(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing')));
    script.onerror = () => {
      loading = undefined; // allow a later try
      script.remove();
      reject(new Error('turnstile script failed'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** The real widget: explicit rendering, the site key from VITE_TURNSTILE_SITE_KEY, action "public_ticket". */
export const realTurnstile: TurnstileLoader = async (container, handlers) => {
  const siteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
  if (!siteKey) throw new Error('VITE_TURNSTILE_SITE_KEY is not set');
  const api = await loadScript();
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
  return { reset: () => api.reset(id), remove: () => api.remove(id) };
};
