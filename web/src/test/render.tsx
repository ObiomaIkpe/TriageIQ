import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { App } from '../App.js';
import { installFocusListener } from '../lib/focus.js';
import { TurnstileProvider } from '../turnstile/context.js';
import type { TurnstileLoader } from '../turnstile/types.js';

installFocusListener();

/** Shows the current path so a test can assert where the app went. */
function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

/** The whole app on a fresh QueryClient (no retries, so a failure shows at once), starting at `path`. */
export function renderApp(path = '/', turnstile?: TurnstileLoader) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        {turnstile ? (
          <TurnstileProvider loader={turnstile}>
            <App />
          </TurnstileProvider>
        ) : (
          <App />
        )}
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}
