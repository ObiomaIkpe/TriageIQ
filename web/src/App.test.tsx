import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { answers, ADA } from './test/gateway.js';
import { renderApp } from './test/render.js';
import { server } from './test/server.js';

const where = () => screen.getByTestId('where').textContent;

describe('routing and the session', () => {
  it('/ goes to /queue (and, logged out, on to /login)', async () => {
    server.use(answers.loggedOut());
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'TriageIQ' })).toBeInTheDocument();
    expect(where()).toBe('/login');
  });

  it('/queue while logged out redirects to /login', async () => {
    server.use(answers.loggedOut());
    renderApp('/queue');
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(where()).toBe('/login');
  });

  it('while the session is being checked only "Loading" is shown: no flash of the login page or the queue', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get('/api/auth/me', async () => {
        await gate;
        return HttpResponse.json(ADA);
      }),
    );
    renderApp('/queue');
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
    expect(screen.queryByText('TriageIQ · Review queue')).not.toBeInTheDocument();
    release();
    expect(await screen.findByText('TriageIQ · Review queue')).toBeInTheDocument();
  });

  it('the queue page is a placeholder with the top bar, the name and a Log out button', async () => {
    server.use(answers.loggedIn());
    renderApp('/queue');
    expect(await screen.findByText('TriageIQ · Review queue')).toBeInTheDocument();
    expect(screen.getByText('The review queue arrives in the next step.')).toBeInTheDocument();
    expect(screen.getByText('Ọbiọma Ụzọ')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();
  });

  it('an unknown route is a simple 404 page', async () => {
    server.use(answers.loggedIn());
    renderApp('/no/such/page');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('a failed session check shows an error with Retry, not the login page', async () => {
    server.use(http.get('/api/auth/me', () => HttpResponse.json({}, { status: 503 })));
    renderApp('/queue');
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong. Please try again.');
    server.use(answers.loggedIn());
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('TriageIQ · Review queue')).toBeInTheDocument();
  });

  it('logout calls the API, empties the whole query cache and goes to /login', async () => {
    let logoutCalls = 0;
    let sessionLives = true; // the fake gateway forgets the session when it answers the logout
    server.use(
      http.get('/api/auth/me', () => (sessionLives ? HttpResponse.json(ADA) : HttpResponse.json({}, { status: 401 }))),
      http.post('/api/auth/logout', () => {
        logoutCalls += 1;
        sessionLives = false;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { queryClient } = renderApp('/queue');
    queryClient.setQueryData(['tickets', 'pending'], [{ id: 'later data' }]);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Log out' }));

    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(where()).toBe('/login');
    expect(logoutCalls).toBe(1);
    expect(queryClient.getQueryData(['tickets', 'pending'])).toBeUndefined();
    expect(queryClient.getQueryData(['me'])).toBeNull(); // re-checked after the clear: logged out, and no user left in memory
  });

  it('a failed logout (network) stays on the page and says so; the session is not pretended to be over', async () => {
    server.use(answers.loggedIn(), http.post('/api/auth/logout', () => HttpResponse.error()));
    renderApp('/queue');
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Log out' }));
    expect(await screen.findByText('Could not log out. Please try again.')).toBeInTheDocument();
    expect(where()).toBe('/queue');
  });

  it('a 401 from a later API call sends the user to /login with "Your session has ended."', async () => {
    server.use(answers.loggedIn(), http.post('/api/auth/logout', () => HttpResponse.json({}, { status: 401 })));
    const { queryClient } = renderApp('/queue');
    queryClient.setQueryData(['tickets', 'pending'], ['x']);
    // Any later call that answers 401 (here the logout call stands in for the future queue calls). The same handler applies:
    // the app-wide session-ended handler needs the call to opt in, which api() does by default; logout opts out because
    // a 401 there is a normal "already logged out". So use a generic call:
    const { api } = await import('./api/client.js');
    server.use(http.get('/api/tickets', () => HttpResponse.json({}, { status: 401 })));
    await screen.findByText('TriageIQ · Review queue');
    server.use(answers.loggedOut());
    await api('/tickets').catch(() => undefined);

    await waitFor(() => expect(where()).toBe('/login'));
    expect(await screen.findByText('Your session has ended. Please log in again.')).toBeInTheDocument();
    expect(queryClient.getQueryData(['tickets', 'pending'])).toBeUndefined();
  });

  it('after the session-ended notice, a failed login attempt replaces it with the new message', async () => {
    server.use(answers.loggedIn());
    renderApp('/queue');
    await screen.findByText('TriageIQ · Review queue');
    const { api } = await import('./api/client.js');
    server.use(http.get('/api/tickets', () => HttpResponse.json({}, { status: 401 })), answers.loggedOut(), answers.loginStatus(401));
    await api('/tickets').catch(() => undefined);
    await screen.findByText('Your session has ended. Please log in again.');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'a@b.c');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('Invalid email or password')).toBeInTheDocument();
    expect(screen.queryByText('Your session has ended. Please log in again.')).not.toBeInTheDocument();
  });
});
