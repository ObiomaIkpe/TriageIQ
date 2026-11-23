import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realTurnstile, resetTurnstileScriptForTests } from './real.js';
import type { TurnstileHandlers } from './types.js';

/** The real loader against a fake window.turnstile: jsdom does not fetch scripts, so the test fires the script's load event itself. */
const handlers: TurnstileHandlers = { onToken: () => undefined, onExpired: () => undefined, onError: () => undefined };
const scripts = () => document.head.querySelectorAll('script[src*="challenges.cloudflare.com"]');

function installApi() {
  let n = 0;
  const api = {
    liveIds: new Set<string>(),
    renderedInto: [] as HTMLElement[],
    render: vi.fn((container: HTMLElement) => {
      if (api.renderedInto.includes(container)) return undefined; // Cloudflare's "already rendered in this container"
      const id = `w${(n += 1)}`;
      api.liveIds.add(id);
      api.renderedInto.push(container);
      container.appendChild(document.createElement('iframe'));
      return id;
    }),
    reset: vi.fn(),
    remove: vi.fn((id: string) => {
      api.liveIds.delete(id);
    }),
  };
  return api;
}
/** Pretend the script finished loading and defined window.turnstile. */
function scriptLoads(api: ReturnType<typeof installApi>) {
  window.turnstile = api as never;
  scripts()[0]?.dispatchEvent(new Event('load'));
}

describe('the real Turnstile loader', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '1x00000000000000000000AA');
    resetTurnstileScriptForTests();
    delete window.turnstile;
    document.head.querySelectorAll('script').forEach((s) => s.remove());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    delete window.turnstile;
  });

  it('StrictMode: two loads and a cleanup in between inject the script ONCE and leave exactly one live widget', async () => {
    const api = installApi();
    const container = document.createElement('div');
    document.body.appendChild(container);

    // mount 1, cleanup (abort), mount 2 — all before the script has loaded
    const first = new AbortController();
    const p1 = realTurnstile(container, handlers, first.signal);
    first.abort();
    const second = new AbortController();
    const p2 = realTurnstile(container, handlers, second.signal);
    expect(scripts()).toHaveLength(1); // the script was injected once

    scriptLoads(api);
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' }); // the cleaned-up run never rendered
    const widget = await p2;

    expect(api.render).toHaveBeenCalledTimes(1);
    expect(api.liveIds.size).toBe(1);
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
    widget.remove();
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(api.liveIds.size).toBe(0);
  });

  it('remove() calls turnstile.remove(id) once and clears the id: a later reset or remove does nothing', async () => {
    const api = installApi();
    window.turnstile = api as never;
    const widget = await realTurnstile(document.createElement('div'), handlers, new AbortController().signal);
    widget.reset();
    expect(api.reset).toHaveBeenCalledWith('w1');
    widget.remove();
    widget.remove();
    widget.reset();
    expect(api.remove).toHaveBeenCalledTimes(1);
    expect(api.remove).toHaveBeenCalledWith('w1');
    expect(api.reset).toHaveBeenCalledTimes(1);
  });

  it('a second load for a container that already holds a widget replaces it (never two)', async () => {
    const api = installApi();
    window.turnstile = api as never;
    const container = document.createElement('div');
    await realTurnstile(container, handlers, new AbortController().signal);
    api.renderedInto.length = 0; // (Cloudflare would refuse a second render here; our guard removes the first one first)
    await realTurnstile(container, handlers, new AbortController().signal);
    expect(api.remove).toHaveBeenCalledWith('w1');
    expect(api.liveIds).toEqual(new Set(['w2']));
    expect(container.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('reuses a <script> tag that is already on the page instead of adding another', async () => {
    const existing = document.createElement('script');
    existing.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    document.head.appendChild(existing);
    const api = installApi();
    const pending = realTurnstile(document.createElement('div'), handlers, new AbortController().signal);
    expect(scripts()).toHaveLength(1);
    scriptLoads(api);
    await pending;
    expect(scripts()).toHaveLength(1);
  });

  it('an aborted call renders nothing even if the script is already there', async () => {
    const api = installApi();
    window.turnstile = api as never;
    const controller = new AbortController();
    controller.abort();
    await expect(realTurnstile(document.createElement('div'), handlers, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(api.render).not.toHaveBeenCalled();
  });

  it('a script that fails to load rejects, removes its tag, and a later call can try again', async () => {
    const pending = realTurnstile(document.createElement('div'), handlers, new AbortController().signal);
    scripts()[0]?.dispatchEvent(new Event('error'));
    await expect(pending).rejects.toThrow();
    expect(scripts()).toHaveLength(0);
    const api = installApi();
    const retry = realTurnstile(document.createElement('div'), handlers, new AbortController().signal);
    expect(scripts()).toHaveLength(1);
    scriptLoads(api);
    await retry;
    expect(api.liveIds.size).toBe(1);
  });

  it('without a site key it refuses to render (and never loads the script)', async () => {
    vi.stubEnv('VITE_TURNSTILE_SITE_KEY', '');
    await expect(realTurnstile(document.createElement('div'), handlers, new AbortController().signal)).rejects.toThrow('VITE_TURNSTILE_SITE_KEY');
    expect(scripts()).toHaveLength(0);
  });
});
