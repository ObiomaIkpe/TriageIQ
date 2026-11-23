import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { answers, ADA } from '../test/gateway.js';
import { queueGateway } from '../test/queueGateway.js';
import { renderApp } from '../test/render.js';
import { server } from '../test/server.js';

async function fillAndSubmit(email = 'tony@triageiq.local', password = 'secret-pass') {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Log in' }));
}

const where = () => screen.getByTestId('where').textContent;

describe('login page', () => {
  it('has a TriageIQ heading, real labels and the right autocomplete hints', async () => {
    server.use(answers.loggedOut());
    renderApp('/login');
    expect(await screen.findByRole('heading', { name: 'TriageIQ' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });

  it('success: goes to /queue and shows the display name exactly (Unicode)', async () => {
    server.use(answers.loggedOut(), answers.loginOk(), ...queueGateway([]).handlers);
    renderApp('/login');
    await fillAndSubmit();
    expect(await screen.findByText('TriageIQ · Review queue')).toBeInTheDocument();
    expect(screen.getByText(ADA.user.display_name)).toBeInTheDocument();
    expect(where()).toBe('/queue');
  });

  it('sends the typed email and password as JSON to /api/auth/login, and stores nothing in the browser', async () => {
    let body: unknown;
    server.use(
      answers.loggedOut(),
      ...queueGateway([]).handlers,
      http.post('/api/auth/login', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(ADA);
      }),
    );
    renderApp('/login');
    await fillAndSubmit('tony@triageiq.local', ' pass with spaces ');
    await screen.findByText('TriageIQ · Review queue');
    expect(body).toEqual({ email: 'tony@triageiq.local', password: ' pass with spaces ' }); // the password is not trimmed
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });

  it('401: "Invalid email or password" in the live region, and the user stays on /login', async () => {
    server.use(answers.loggedOut(), answers.loginStatus(401));
    renderApp('/login');
    await fillAndSubmit();
    const message = await screen.findByText('Invalid email or password');
    expect(message).toHaveAttribute('aria-live', 'polite');
    expect(where()).toBe('/login');
  });

  it.each([
    [60, 'Too many attempts. Try again in 1 minute.'],
    [61, 'Too many attempts. Try again in 2 minutes.'],
    [1, 'Too many attempts. Try again in 1 minute.'],
    [900, 'Too many attempts. Try again in 15 minutes.'],
    [899, 'Too many attempts. Try again in 15 minutes.'],
  ])('429 with Retry-After %i s -> "%s" (rounded up)', async (seconds, text) => {
    server.use(answers.loggedOut(), answers.loginStatus(429, { 'Retry-After': String(seconds) }));
    renderApp('/login');
    await fillAndSubmit();
    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it('429 without a usable Retry-After does not invent a number', async () => {
    server.use(answers.loggedOut(), answers.loginStatus(429));
    renderApp('/login');
    await fillAndSubmit();
    expect(await screen.findByText('Too many attempts. Try again later.')).toBeInTheDocument();
  });

  it('a network error and a 5xx both say "Something went wrong. Please try again."', async () => {
    server.use(answers.loggedOut(), answers.loginNetworkError());
    const first = renderApp('/login');
    await fillAndSubmit();
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
    first.unmount();

    server.use(answers.loginStatus(503));
    renderApp('/login');
    await fillAndSubmit();
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
  });

  it('the button is disabled while the request is running, and a double submit sends one request', async () => {
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      answers.loggedOut(),
      ...queueGateway([]).handlers,
      http.post('/api/auth/login', async () => {
        calls += 1;
        await gate;
        return HttpResponse.json(ADA);
      }),
    );
    renderApp('/login');
    await fillAndSubmit();
    const button = screen.getByRole('button', { name: 'Log in' });
    await waitFor(() => expect(button).toBeDisabled());
    await userEvent.setup().click(button);
    release();
    await screen.findByText('TriageIQ · Review queue');
    expect(calls).toBe(1);
  });

  it('a user who is already logged in is redirected from /login to /queue', async () => {
    server.use(answers.loggedIn(), ...queueGateway([]).handlers);
    renderApp('/login');
    expect(await screen.findByText('TriageIQ · Review queue')).toBeInTheDocument();
    expect(where()).toBe('/queue');
  });
});
