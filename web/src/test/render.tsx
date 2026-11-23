import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { StrictMode } from 'react';
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
export function renderApp(path = '/', turnstile?: TurnstileLoader, options: { strict?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const Wrapper = options.strict ? StrictMode : ({ children }: { children: React.ReactNode }) => <>{children}</>;
  const view = render(
    <Wrapper>
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
    </QueryClientProvider>
    </Wrapper>,
  );
  return { ...view, queryClient };
}
