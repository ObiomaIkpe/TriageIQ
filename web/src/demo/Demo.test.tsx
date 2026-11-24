import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { answers } from '../test/gateway.js';
import { fakeTurnstile } from '../test/fakeTurnstile.js';
import { makeTicket, queueGateway } from '../test/queueGateway.js';
import { renderApp } from '../test/render.js';
import { server } from '../test/server.js';

const BANNER = 'Demo mode — example data, resets nightly. Emails are never sent.';
const where = () => screen.getByTestId('where').textContent;

describe('the demo button on the login page', () => {
  it('is not there when the gateway has the demo off (the standing answer is 404)', async () => {
    server.use(answers.loggedOut());
    renderApp('/login');
    await screen.findByRole('button', { name: 'Log in' });
    expect(screen.queryByRole('button', { name: /Try it as a reviewer/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Explore with example tickets/)).not.toBeInTheDocument();
  });

  it('is there when the demo is on, with its one line of explanation', async () => {
    server.use(answers.loggedOut(), answers.demoOn());
    renderApp('/login');
    expect(await screen.findByRole('button', { name: 'Try it as a reviewer (demo)' })).toBeInTheDocument();
    expect(screen.getByText('Explore with example tickets. No account needed. Nothing is emailed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument(); // the real login is still the main thing
  });

  it('is secondary: it is not the form\'s submit button, and a click does not need the email or password', async () => {
    server.use(answers.loggedOut(), answers.demoOn());
    renderApp('/login');
    const button = await screen.findByRole('button', { name: /Try it as a reviewer/ });
    expect(button).toHaveAttribute('type', 'button');
  });

  it('one click logs in as the demo visitor (POST /api/auth/demo-login, no body) and opens the queue with the banner', async () => {
    let body: string | undefined;
    let headers: Headers | undefined;
    server.use(
      answers.loggedOut(),
      answers.demoOn(),
      ...queueGateway([]).handlers,
      http.post('/api/auth/demo-login', async ({ request }) => {
        body = await request.text();
        headers = request.headers;
        return HttpResponse.json((await import('../test/gateway.js')).DEMO_VISITOR);
      }),
    );
    renderApp('/login');
    await userEvent.setup().click(await screen.findByRole('button', { name: /Try it as a reviewer/ }));
    expect(await screen.findByText('TriageIQ · Review queue')).toBeInTheDocument();
    expect(where()).toBe('/queue');
    expect(body).toBe('');
    expect(headers?.get('content-type')).toBeNull();
    expect(screen.getByText(BANNER)).toBeInTheDocument();
    expect(screen.getByText('Demo Reviewer')).toBeInTheDocument();
  });

  it('says so when the demo refuses (too many visits, or off)', async () => {
    server.use(answers.loggedOut(), answers.demoOn(), http.post('/api/auth/demo-login', () => HttpResponse.json({ message: 'x' }, { status: 429, headers: { 'Retry-After': '60' } })));
    renderApp('/login');
    await userEvent.setup().click(await screen.findByRole('button', { name: /Try it as a reviewer/ }));
    expect(await screen.findByText('Too many demo visits from your network. Try again later.')).toBeInTheDocument();
    expect(where()).toBe('/login');
  });
});

describe('the banner and the test-ticket box belong to the demo visitor only', () => {
  it('a demo visitor sees the banner and the "Submit a test ticket" box in the queue', async () => {
    server.use(answers.demoLoggedIn(), ...queueGateway([]).handlers);
    renderApp('/queue', fakeTurnstile().loader);
    expect(await screen.findByText(BANNER)).toBeInTheDocument();
    expect(screen.getByText('Submit a test ticket')).toBeInTheDocument();
  });

  it('a real reviewer sees neither, nor any demo wording', async () => {
    server.use(answers.loggedIn(), ...queueGateway([makeTicket()]).handlers);
    renderApp('/queue');
    await screen.findByText('TriageIQ · Review queue');
    await screen.findByText(/Subject/);
    expect(screen.queryByText(BANNER)).not.toBeInTheDocument();
    expect(screen.queryByText('Submit a test ticket')).not.toBeInTheDocument();
    expect(screen.queryByRole('note', { name: 'Demo mode' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/demo/i);
  });
});

describe('Submit a test ticket', () => {
  async function openBox(turnstile = fakeTurnstile()) {
    const gateway = queueGateway([]);
    const seen: { body?: unknown; key?: string | null }[] = [];
    server.use(
      answers.demoLoggedIn(),
      ...gateway.handlers,
      http.post('/api/demo/tickets', async ({ request }) => {
        seen.push({ body: await request.json(), key: request.headers.get('idempotency-key') });
        return HttpResponse.json({ reference: 'TKT-NEW234', message: 'Thanks' }, { status: 202 });
      }),
    );
    renderApp('/queue', turnstile.loader);
    const user = userEvent.setup();
    await user.click(await screen.findByText('Submit a test ticket'));
    return { user, turnstile, seen };
  }

  it('sends subject, message and the Turnstile token, with an idempotency key, then says it is visible to other visitors', async () => {
    const { user, turnstile, seen } = await openBox();
    await user.type(screen.getByLabelText('Subject'), 'My refund');
    await user.type(screen.getByLabelText('Message'), 'Please refund me');
    await waitFor(() => expect(turnstile.state.renders).toBe(1));
    expect(screen.getByRole('button', { name: 'Send test ticket' })).toBeDisabled(); // no token yet
    turnstile.token('tok-demo');
    await user.click(await screen.findByRole('button', { name: 'Send test ticket' }));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]!.body).toEqual({ subject: 'My refund', message: 'Please refund me', turnstile_token: 'tok-demo' });
    expect(seen[0]!.key).toMatch(/^[0-9a-f-]{36}$/);
    const status = await screen.findByText(/Submitted TKT-NEW234/);
    expect(status.textContent).toContain('Visible to other demo visitors until the nightly reset');
    expect((screen.getByLabelText('Subject') as HTMLInputElement).value).toBe('');
  });

  it('the box says up front that the ticket is visible to other demo visitors', async () => {
    await openBox();
    expect(screen.getByText(/visible to other demo visitors until the nightly reset/i)).toBeInTheDocument();
  });

  it('asks for no name or email (the customer is always the fixed "Demo Visitor")', async () => {
    await openBox();
    expect(screen.queryByLabelText(/name/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/email/i)).not.toBeInTheDocument();
  });

  it('does not send without a subject and a message', async () => {
    const { user, turnstile, seen } = await openBox();
    await waitFor(() => expect(turnstile.state.renders).toBe(1));
    turnstile.token();
    await user.click(await screen.findByRole('button', { name: 'Send test ticket' }));
    expect(await screen.findByText('Please fill in both the subject and the message.')).toBeInTheDocument();
    expect(seen).toHaveLength(0);
  });

  it('a refusal (daily limit / busy) is explained, and a new token is asked for', async () => {
    const turnstile = fakeTurnstile();
    const gateway = queueGateway([]);
    server.use(answers.demoLoggedIn(), ...gateway.handlers, http.post('/api/demo/tickets', () => HttpResponse.json({ message: 'cap' }, { status: 503 })));
    renderApp('/queue', turnstile.loader);
    const user = userEvent.setup();
    await user.click(await screen.findByText('Submit a test ticket'));
    await user.type(screen.getByLabelText('Subject'), 'S');
    await user.type(screen.getByLabelText('Message'), 'M');
    await waitFor(() => expect(turnstile.state.renders).toBe(1));
    turnstile.token();
    await user.click(await screen.findByRole('button', { name: 'Send test ticket' }));
    expect(await screen.findByText('The demo has reached its limit for today, or is busy. Please try again later.')).toBeInTheDocument();
    expect(turnstile.state.resets).toBe(1);
    expect(screen.getByRole('button', { name: 'Send test ticket' })).toBeDisabled();
  });
});

describe('a demo ticket in the detail panel', () => {
  const demoPending = () =>
    makeTicket({ is_demo: true, customer_name: 'Maya Okafor', customer_email: 'maya@example.com', subject: 'Locked out', suggested_reply: 'Wait one hour.' });

  it('approving it shows that the reply would have been emailed, with the email exactly as a real send, and never asks for a delivery', async () => {
    const ticket = demoPending();
    const gateway = queueGateway([ticket]);
    server.use(answers.demoLoggedIn(), ...gateway.handlers);
    renderApp(`/queue?tab=pending&ticket=${ticket.reference}`, fakeTurnstile().loader);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Approve draft' }));
    expect(await screen.findByText('Demo: this reply would have been emailed to the customer')).toBeInTheDocument();
    const panel = screen.getByRole('article');
    expect(within(panel).getByText(`Re: Locked out [${ticket.reference}]`)).toBeInTheDocument();
    expect(within(panel).getByText('maya@example.com')).toBeInTheDocument();
    expect(panel.textContent).toContain(`Reference: ${ticket.reference}`);
    expect(gateway.state.calls.some((c) => c.path.endsWith('/delivery'))).toBe(false);
    expect(screen.queryByText(/Reply sent|Sending…|Retry sending/)).not.toBeInTheDocument();
  });

  it('a decided demo example read later shows the same notice (no delivery lookup)', async () => {
    const ticket = makeTicket({ is_demo: true, status: 'edited', final_reply: 'The edited text', customer_email: 'priya@example.com', reviewed_by: { id: 'client:demo-reviewer', name: 'Demo Reviewer' }, reviewed_at: '2026-11-24T10:00:00.000Z' });
    const gateway = queueGateway([ticket]);
    server.use(answers.demoLoggedIn(), ...gateway.handlers);
    renderApp(`/queue?tab=edited&ticket=${ticket.reference}`, fakeTurnstile().loader);
    expect(await screen.findByText('Demo: this reply would have been emailed to the customer')).toBeInTheDocument();
    expect(screen.getByText(/Reviewed by Demo Reviewer/)).toBeInTheDocument();
    expect(gateway.state.calls.some((c) => c.path.endsWith('/delivery'))).toBe(false);
  });

  it('a rejected demo ticket has no email notice', async () => {
    const ticket = makeTicket({ is_demo: true, status: 'rejected', final_reply: null });
    server.use(answers.demoLoggedIn(), ...queueGateway([ticket]).handlers);
    renderApp(`/queue?tab=rejected&ticket=${ticket.reference}`, fakeTurnstile().loader);
    await screen.findByText('No reply was sent (rejected).');
    expect(screen.queryByText(/would have been emailed/)).not.toBeInTheDocument();
  });

  it('a REAL approved ticket still shows its delivery status, and no demo wording', async () => {
    const ticket = makeTicket({ status: 'approved', final_reply: 'Sent text', customer_email: 'ada@example.com', reviewed_by: { id: 'user:1', name: 'Grace' }, reviewed_at: '2026-11-24T10:00:00.000Z' });
    const gateway = queueGateway([ticket]);
    gateway.state.deliveries.set(ticket.ticket_id, { status: 'sent', attempts: 1, sent_at: '2026-11-24T10:01:00.000Z', error: null });
    server.use(answers.loggedIn(), ...gateway.handlers);
    renderApp(`/queue?tab=approved&ticket=${ticket.reference}`);
    expect(await screen.findByText(/Reply sent/)).toBeInTheDocument();
    expect(screen.queryByText(/would have been emailed/)).not.toBeInTheDocument();
  });
});
