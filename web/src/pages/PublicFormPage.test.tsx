import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { fakeTurnstile } from '../test/fakeTurnstile.js';
import { renderApp } from '../test/render.js';
import { server } from '../test/server.js';

interface Seen {
  headers: Headers;
  body: Record<string, unknown>;
}

/** A fake gateway for the public form. `answers` are used one per request (the last repeats). */
function publicGateway(...answers: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
  const seen: Seen[] = [];
  const authCalls: string[] = [];
  server.use(
    http.get('/api/auth/me', ({ request }) => {
      authCalls.push(request.url);
      return HttpResponse.json({}, { status: 401 });
    }),
    http.post('/api/public/tickets', async ({ request }) => {
      seen.push({ headers: request.headers, body: (await request.json()) as Record<string, unknown> });
      const a = answers[Math.min(seen.length - 1, answers.length - 1)] ?? { status: 202, body: { reference: 'TKT-ABC234', message: 'Thanks, we received your message.' } };
      return HttpResponse.json(a.body ?? {}, { status: a.status, headers: a.headers });
    }),
  );
  return { seen, authCalls };
}
const OK = { status: 202, body: { reference: 'TKT-7K3M9Q', message: 'Thanks, we received your message.' } };

async function fill(user: ReturnType<typeof userEvent.setup>, over: Partial<Record<'name' | 'email' | 'subject' | 'message', string>> = {}) {
  const v = { name: 'Ada Lovelace', email: 'ada@example.com', subject: 'Invoice', message: 'Where is my invoice?', ...over };
  for (const [label, value] of [['Name', v.name], ['Email', v.email], ['Subject', v.subject], ['Message', v.message]] as const) {
    const box = await screen.findByLabelText(label);
    await user.clear(box);
    if (value) await user.type(box, value);
  }
}
const send = () => screen.getByRole('button', { name: /^(Send|Sending…)$/ });

function open(turnstile = fakeTurnstile(), path = '/', options: { strict?: boolean } = {}) {
  const view = renderApp(path, turnstile.loader, options);
  return { turnstile, ...view };
}

describe('the public contact form', () => {
  it('is the page at "/" and "/submit", with labelled fields, and never asks who you are (/api/auth/me)', async () => {
    const g = publicGateway();
    open();
    expect(await screen.findByRole('heading', { name: 'Contact support' })).toBeInTheDocument();
    expect(screen.getByText('We usually reply within one working day.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('type', 'email');
    expect(screen.getByLabelText('Email')).toHaveAttribute('autocomplete', 'email');
    expect(screen.getByLabelText('Subject')).toBeInTheDocument();
    expect(screen.getByLabelText('Message').tagName).toBe('TEXTAREA');
    expect(screen.queryByRole('status', { name: /loading/i })).not.toBeInTheDocument(); // no loading gate
    expect(g.authCalls).toEqual([]);
  });

  it('"/submit" shows the same form', async () => {
    publicGateway();
    open(fakeTurnstile(), '/submit');
    expect(await screen.findByRole('heading', { name: 'Contact support' })).toBeInTheDocument();
  });

  it('Send is disabled until Turnstile gives a token', async () => {
    publicGateway();
    const { turnstile } = open();
    await screen.findByLabelText('Name');
    expect(send()).toBeDisabled();
    await waitFor(() => expect(turnstile.state.renders).toBe(1));
    act(() => turnstile.token());
    await waitFor(() => expect(send()).toBeEnabled());
  });

  it('the honeypot "website" is off-screen (not display:none), aria-hidden, unreachable by keyboard and not autofilled', async () => {
    publicGateway();
    open();
    await screen.findByLabelText('Name');
    const trap = document.querySelector('input[name="website"]') as HTMLInputElement;
    expect(trap).toHaveAttribute('aria-hidden', 'true');
    expect(trap).toHaveAttribute('tabindex', '-1');
    expect(trap).toHaveAttribute('autocomplete', 'off');
    expect(trap.parentElement?.closest('[aria-hidden="true"]')?.className).toContain('absolute'); // the wrapper moves it off-screen
    expect(trap.closest('[style*="display: none"]')).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Website' })).not.toBeInTheDocument(); // not in the accessibility tree
  });

  it('success: sends the form with an Idempotency-Key and no Authorization, shows the reference, Copy works, focus moves to the heading', async () => {
    const g = publicGateway(OK);
    const { turnstile } = open();
    const user = userEvent.setup();
    await fill(user);
    await waitFor(() => expect(turnstile.state.renders).toBe(1));
    act(() => turnstile.token('tok-abc'));
    await user.click(send());

    const heading = await screen.findByRole('heading', { name: 'Thanks, we received your message.' });
    expect(screen.getByTestId('reference')).toHaveTextContent('TKT-7K3M9Q');
    expect(heading).toHaveFocus();
    expect(g.seen[0]?.body).toEqual({ name: 'Ada Lovelace', email: 'ada@example.com', subject: 'Invoice', message: 'Where is my invoice?', turnstile_token: 'tok-abc', website: '' });
    expect(g.seen[0]?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(g.seen[0]?.headers.get('authorization')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Copied')).toBeInTheDocument();
    expect(await navigator.clipboard.readText()).toBe('TKT-7K3M9Q');
  });

  it('shows nothing but the thank-you and the reference (no AI output, no job information)', async () => {
    publicGateway({ status: 202, body: { reference: 'TKT-7K3M9Q', message: 'Thanks, we received your message.', category: 'billing', suggested_reply: 'AI TEXT' } });
    const { turnstile } = open();
    const user = userEvent.setup();
    await fill(user);
    await waitFor(() => expect(turnstile.state.renders).toBe(1));
    act(() => turnstile.token());
    await user.click(send());
    await screen.findByTestId('reference');
    expect(document.body).not.toHaveTextContent('AI TEXT');
    expect(document.body).not.toHaveTextContent('billing');
  });

  it('keeps the SAME idempotency key when the same message is retried after a failure, and asks Turnstile for a new token', async () => {
    const g = publicGateway({ status: 503, body: { message: 'x' } }, OK);
    const { turnstile } = open();
    const user = userEvent.setup();
    await fill(user);
    await waitFor(() => expect(turnstile.state.renders).toBe(1));
    act(() => turnstile.token('tok-1'));
    await user.click(send());
    expect(await screen.findByText("We're very busy right now. Please try again later.")).toBeInTheDocument();
    expect(turnstile.state.resets).toBe(1);
    expect(send()).toBeDisabled(); // the token was used: a new one is needed

    act(() => turnstile.token('tok-2'));
    await user.click(await screen.findByRole('button', { name: 'Send' }));
    await screen.findByTestId('reference');
    expect(g.seen).toHaveLength(2);
    expect(g.seen[1]?.headers.get('idempotency-key')).toBe(g.seen[0]?.headers.get('idempotency-key'));
    expect(g.seen[1]?.body.turnstile_token).toBe('tok-2');
  });

  it('uses a NEW key if the message was changed after a failure (the gateway refuses a key reused with different content)', async () => {
    const g = publicGateway({ status: 503 }, OK);
    const { turnstile } = open();
    const user = userEvent.setup();
    await fill(user);
    await waitFor(() => expect(turnstile.state.renders).toBe(1));
    act(() => turnstile.token());
    await user.click(send());
    await screen.findByText("We're very busy right now. Please try again later.");
    await user.type(screen.getByLabelText('Message'), ' It is order 1042.');
    act(() => turnstile.token('tok-2'));
    await user.click(await screen.findByRole('button', { name: 'Send' }));
    await screen.findByTestId('reference');
    expect(g.seen[1]?.headers.get('idempotency-key')).not.toBe(g.seen[0]?.headers.get('idempotency-key'));
  });

  it('"Send another message" gives a fresh form with a new idempotency key', async () => {
    const g = publicGateway(OK);
    const { turnstile } = open();
    const user = userEvent.setup();
    await fill(user);
    await waitFor(() => expect(turnstile.state.renders).toBe(1));
    act(() => turnstile.token());
    await user.click(send());
    await user.click(await screen.findByRole('button', { name: 'Send another message' }));
    expect(await screen.findByLabelText('Name')).toHaveValue('');
    await fill(user);
    await waitFor(() => expect(turnstile.state.renders).toBe(2)); // a new widget for the new form
    expect(turnstile.state.refused).toBe(0);
    act(() => turnstile.token('tok-2'));
    await user.click(send());
    await screen.findByTestId('reference');
    expect(g.seen[1]?.headers.get('idempotency-key')).not.toBe(g.seen[0]?.headers.get('idempotency-key'));
  });

  it('a 400 puts the gateway\'s field errors next to the matching fields', async () => {
    publicGateway({
      status: 400,
      body: { message: 'Please check the form and try again.', errors: [{ field: 'email', problem: 'is invalid' }, { field: 'subject', problem: 'must be at most 200 characters' }, { field: 'name', problem: 'must not be empty' }] },
    });
    const { turnstile } = open();
    const user = userEvent.setup();
    await fill(user);
    await waitFor(() => expect(turnstile.state.renders).toBe(1));
    act(() => turnstile.token());
    await user.click(send());
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Enter a valid email address.');
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Subject')).toHaveAccessibleDescription('Subject must be at most 200 characters.');
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('Name is required.');
    expect(turnstile.state.resets).toBe(1);
  });

  it.each([
    ['403', { status: 403, body: { message: 'x' } }, 'Verification failed, please try again.'],
    ['429 with 61 s (rounds up)', { status: 429, body: {}, headers: { 'Retry-After': '61' } }, "You've sent several messages recently. Try again in 2 minutes."],
    ['429 with 60 s', { status: 429, body: {}, headers: { 'Retry-After': '60' } }, "You've sent several messages recently. Try again in 1 minute."],
    ['503', { status: 503, body: { message: 'x' }, headers: { 'Retry-After': '600' } }, "We're very busy right now. Please try again later."],
    ['404', { status: 404, body: {} }, 'The contact form is currently unavailable.'],
    ['500', { status: 500, body: {} }, "We're very busy right now. Please try again later."],
    ['422', { status: 422, body: {} }, 'Something went wrong. Please try again.'],
  ])('%s shows the right message in the live region', async (_name, answer, text) => {
    publicGateway(answer);
    const { turnstile } = open();
    const user = userEvent.setup();
    await fill(user);
    await waitFor(() => expect(turnstile.state.renders).toBe(1));
    act(() => turnstile.token());
    await user.click(send());
    const message = await screen.findByText(text);
    expect(message).toHaveAttribute('aria-live', 'polite');
  });

  it('a network error says "Something went wrong. Please try again."', async () => {
    server.use(http.post('/api/public/tickets', () => HttpResponse.error()));
    const { turnstile } = open();
    const user = userEvent.setup();
    await fill(user);
    await waitFor(() => expect(turnstile.state.renders).toBe(1));
    act(() => turnstile.token());
    await user.click(send());
    expect(await screen.findByText('Something went wrong. Please try again.')).toBeInTheDocument();
  });

  it('checks the same limits as the gateway before sending, and counts the message live', async () => {
    const g = publicGateway(OK);
    const { turnstile } = open();
    const user = userEvent.setup();
    await waitFor(() => expect(turnstile.state.renders).toBe(1));
    act(() => turnstile.token());
    await user.click(await screen.findByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Name is required.')).toBeInTheDocument();
    expect(screen.getByText('Email is required.')).toBeInTheDocument();
    expect(screen.getByText('Subject is required.')).toBeInTheDocument();
    expect(screen.getByText('Message is required.')).toBeInTheDocument();
    expect(g.seen).toHaveLength(0); // nothing was sent

    await user.type(screen.getByLabelText('Message'), 'hello');
    expect(screen.getByText('5 / 5000')).toBeInTheDocument();
    await fill(user, { email: 'not-an-email', subject: 'x'.repeat(201) });
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Subject must be at most 200 characters.')).toBeInTheDocument();
    expect(g.seen).toHaveLength(0);
  });

  it('a double click sends one request and shows "Sending…"', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    server.use(
      http.post('/api/public/tickets', async () => {
        calls += 1;
        await gate;
        return HttpResponse.json(OK.body, { status: 202 });
      }),
    );
    const { turnstile } = open();
    const user = userEvent.setup();
    await fill(user);
    await waitFor(() => expect(turnstile.state.renders).toBe(1));
    act(() => turnstile.token());
    await user.click(send());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled());
    await user.click(screen.getByRole('button', { name: 'Sending…' }));
    release();
    await screen.findByTestId('reference');
    expect(calls).toBe(1);
  });

  it('forwards the honeypot value if (a bot) fills it', async () => {
    const g = publicGateway(OK);
    const { turnstile } = open();
    const user = userEvent.setup();
    await fill(user);
    await user.type(document.querySelector('input[name="website"]') as HTMLInputElement, 'http://spam');
    await waitFor(() => expect(turnstile.state.renders).toBe(1));
    act(() => turnstile.token());
    await user.click(send());
    await screen.findByTestId('reference');
    expect(g.seen[0]?.body.website).toBe('http://spam');
  });

  it('if the Turnstile script cannot load: says so and keeps Send disabled', async () => {
    publicGateway(OK);
    open(fakeTurnstile({ failToLoad: true }));
    expect(await screen.findByText("Verification couldn't load. Check your connection and refresh.")).toBeInTheDocument();
    expect(send()).toBeDisabled();
  });

  it('an expired token or a widget error disables Send again with a clear message', async () => {
    publicGateway(OK);
    const { turnstile } = open();
    await waitFor(() => expect(turnstile.state.renders).toBe(1));
    act(() => turnstile.token());
    await waitFor(() => expect(send()).toBeEnabled());
    act(() => turnstile.expire());
    expect(await screen.findByText('The verification expired. Please complete it again.')).toBeInTheDocument();
    expect(send()).toBeDisabled();
    act(() => turnstile.token('fresh'));
    await waitFor(() => expect(send()).toBeEnabled());
    act(() => turnstile.fail());
    expect(await screen.findByText('The verification could not run. Please try again.')).toBeInTheDocument();
    expect(send()).toBeDisabled();
  });

  describe('React StrictMode (development mounts, unmounts and mounts again)', () => {
    it('ends with exactly one live widget, the second render succeeds, and nothing was refused', async () => {
      publicGateway(OK);
      const { turnstile } = open(fakeTurnstile(), '/', { strict: true });
      await screen.findByLabelText('Name');
      await waitFor(() => expect(turnstile.state.live).toBe(1));
      await new Promise((resolve) => setTimeout(resolve, 20)); // let any stray render finish
      expect(turnstile.state.calls).toBe(2); // mounted twice
      expect(turnstile.state.refused).toBe(0); // the second render was NOT rejected
      expect(turnstile.state.live).toBe(1);
      expect(turnstile.state.renders - turnstile.state.removes).toBe(1);
      act(() => turnstile.token());
      await waitFor(() => expect(send()).toBeEnabled()); // and a token reaches the form
    });

    it('works end to end: token, send, reference; reset and "Send another message" keep one live widget', async () => {
      publicGateway({ status: 503 }, OK);
      const { turnstile } = open(fakeTurnstile(), '/', { strict: true });
      const user = userEvent.setup();
      await fill(user);
      await waitFor(() => expect(turnstile.state.live).toBe(1));
      act(() => turnstile.token('a'));
      await user.click(send());
      await screen.findByText("We're very busy right now. Please try again later.");
      expect(turnstile.state.resets).toBe(1);
      expect(turnstile.state.live).toBe(1); // a reset keeps the widget, it does not add one
      act(() => turnstile.token('b'));
      await user.click(await screen.findByRole('button', { name: 'Send' }));
      await user.click(await screen.findByRole('button', { name: 'Send another message' }));
      await screen.findByLabelText('Name');
      await waitFor(() => expect(turnstile.state.live).toBe(1)); // the old form's widget was removed, the new form has one
      expect(turnstile.state.refused).toBe(0);
    });

    it('leaving the page removes the widget', async () => {
      publicGateway(OK);
      const { turnstile, unmount } = open(fakeTurnstile(), '/', { strict: true });
      await waitFor(() => expect(turnstile.state.live).toBe(1));
      unmount();
      expect(turnstile.state.live).toBe(0);
    });
  });
});
