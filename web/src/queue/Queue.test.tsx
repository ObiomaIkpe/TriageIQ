import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { answers } from '../test/gateway.js';
import { makeTicket, queueGateway } from '../test/queueGateway.js';
import { renderApp } from '../test/render.js';
import { server } from '../test/server.js';
import { relativeTime } from '../lib/time.js';
import { deliveryPolling } from './useQueue.js';

const where = () => screen.getByTestId('where').textContent;

function start(tickets: ReturnType<typeof makeTicket>[], path = '/queue') {
  const gateway = queueGateway(tickets);
  server.use(answers.loggedIn(), ...gateway.handlers);
  return { gateway, ...renderApp(path) };
}
const detail = () => screen.getByRole('region', { name: 'Ticket' });
const reviewCalls = (g: ReturnType<typeof queueGateway>) => g.state.calls.filter((c) => c.method === 'POST');

describe('the list and the tabs', () => {
  it('shows a card per pending ticket (reference, status, subject, why, category · urgency · age) and the counts on the tabs', async () => {
    start([makeTicket({ subject: 'Cannot log in', review_reason: 'Low confidence', minutesAgo: 5 }), makeTicket({ status: 'approved' }), makeTicket({ status: 'triaged' })]);
    const card = await screen.findByRole('button', { name: /Cannot log in/ });
    expect(card).toHaveTextContent('Pending');
    expect(card).toHaveTextContent('Low confidence');
    expect(card).toHaveTextContent('account · high · 5 min ago');
    expect(await screen.findByRole('tab', { name: /Pending\s*1/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Approved\s*1/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Edited\s*0/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Rejected\s*0/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Auto-handled\s*1/ })).toBeInTheDocument();
  });

  it('the tab is in the URL: clicking one changes ?tab and the list', async () => {
    start([makeTicket({ subject: 'Waiting one' }), makeTicket({ status: 'approved', subject: 'Done one' })]);
    await screen.findByText('Waiting one');
    await userEvent.setup().click(screen.getByRole('tab', { name: /Approved/ }));
    expect(await screen.findByText('Done one')).toBeInTheDocument();
    expect(screen.queryByText('Waiting one')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Approved/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('?tab=auto opens the Auto-handled tickets directly', async () => {
    start([makeTicket({ status: 'triaged', subject: 'Handled by the AI', needs_human_review: false, review_reason: null })], '/queue?tab=auto');
    expect(await screen.findByText('Handled by the AI')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Auto-handled/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('an empty pending tab says the queue is clear', async () => {
    start([makeTicket({ status: 'approved' })]);
    expect(await screen.findByText('Nothing waiting. The queue is clear.')).toBeInTheDocument();
  });

  it('"Load more" asks for the page after the last ticket (keyset cursor) and appends it', async () => {
    const many = Array.from({ length: 23 }, (_, i) => makeTicket({ subject: `Ticket number ${i}`, minutesAgo: i + 1 }));
    const { gateway } = start(many);
    await screen.findByText('Ticket number 0');
    expect(screen.getAllByRole('button', { name: /Ticket number/ })).toHaveLength(20);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Ticket number 22');
    expect(screen.getAllByRole('button', { name: /Ticket number/ })).toHaveLength(23);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    const second = gateway.state.calls.filter((c) => c.path === '/tickets').find((c) => c.search.includes('cursor='));
    const last = [...many].sort((a, b) => b.created_at.localeCompare(a.created_at))[19]!;
    expect(new URLSearchParams(second?.search).get('cursor')).toBe(`${last.created_at}|${last.ticket_id}`);
  });
});

describe('the detail panel', () => {
  it('selecting a card opens it and puts ?ticket=<reference> in the URL', async () => {
    const t = makeTicket({ subject: 'Open me', customer_name: 'Ada', customer_email: 'ada@example.com', confidence: 0.42 });
    start([t]);
    await userEvent.setup().click(await screen.findByRole('button', { name: /Open me/ }));
    const panel = await screen.findByRole('article', { name: `Ticket ${t.reference}` });
    expect(within(panel).getByText('Ada · ada@example.com')).toBeInTheDocument();
    expect(within(panel).getByText(t.review_reason!)).toBeInTheDocument();
    expect(within(panel).getByText('42%')).toBeInTheDocument();
    expect(within(panel).getByText('Account lockout', { exact: false })).toBeInTheDocument();
    expect(within(panel).getByText('Lockout clears after 1 hour.')).toBeInTheDocument();
    expect(within(panel).getByText(t.suggested_reply!)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open me/ })).toHaveAttribute('aria-current', 'true');
  });

  it('a link with ?ticket=<reference> opens that ticket directly', async () => {
    const t = makeTicket({ subject: 'Linked' });
    start([makeTicket(), t], `/queue?tab=pending&ticket=${t.reference}`);
    expect(await screen.findByRole('article', { name: `Ticket ${t.reference}` })).toBeInTheDocument();
  });

  it('an unknown reference says "Ticket not found."', async () => {
    start([makeTicket()], '/queue?ticket=TKT-AAAAAA');
    expect(await screen.findByText('Ticket not found.')).toBeInTheDocument();
  });

  it('with no draft and no article: says so, Approve is disabled with an explanation, Edit and Reject still work', async () => {
    const t = makeTicket({ suggested_reply: null, kb_sources: [] });
    start([t], `/queue?ticket=${t.reference}`);
    const approve = await screen.findByRole('button', { name: 'Approve draft' });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(/no draft to approve/i);
    expect(screen.getByText('No article matched, so any reply must come from a person.')).toBeInTheDocument();
    expect(screen.getByText('No draft. Edit to write the reply yourself, or reject.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
  });

  it('customer and model text is shown literally: HTML is text, not markup, and nothing is linked', async () => {
    const t = makeTicket({
      subject: '<b>hi</b>',
      body: '<img src=x onerror=alert(1)>\nsecond line https://example.com **bold**',
      customer_name: '<i>Eve</i>',
      customer_email: 'eve@example.com',
      suggested_reply: '<script>alert(1)</script>',
      kb_sources: [{ topic: '<u>topic</u>', content: '<a href="http://evil">x</a>', distance: 0.1 }],
    });
    start([t], `/queue?ticket=${t.reference}`);
    const panel = await screen.findByRole('article');
    expect(within(panel).getByText('<b>hi</b>')).toBeInTheDocument();
    expect(within(panel).getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    expect(within(panel).getByText(/https:\/\/example.com \*\*bold\*\*/)).toBeInTheDocument();
    expect(within(panel).getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(panel.querySelector('b, i, u, img, script, a, strong, em')).toBeNull(); // no element was created from customer text
    expect(screen.getByRole('button', { name: /<b>hi<\/b>/ })).toBeInTheDocument(); // the card shows it literally too
  });
});

describe('reviewing', () => {
  it('Approve sends action=approve (and the note, if any), then confirms and opens the next pending ticket', async () => {
    const first = makeTicket({ subject: 'First', minutesAgo: 1 });
    const second = makeTicket({ subject: 'Second', minutesAgo: 2 });
    const { gateway } = start([first, second], `/queue?ticket=${first.reference}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Review note (optional)'), '  looks fine ');
    await user.click(screen.getByRole('button', { name: 'Approve draft' }));

    await waitFor(() => expect(where()).toBe('/queue'));
    expect(reviewCalls(gateway)[0]?.body).toEqual({ action: 'approve', note: 'looks fine' });
    expect(await screen.findByRole('article', { name: `Ticket ${second.reference}` })).toBeInTheDocument(); // the next one opened
    expect(screen.getByRole('status')).toHaveTextContent(`Approved ${first.reference}. Opened ${second.reference}.`);
    expect(await screen.findByRole('tab', { name: /Pending\s*1/ })).toBeInTheDocument(); // the counts refreshed
    expect(screen.getByRole('tab', { name: /Approved\s*1/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /First/ })).not.toBeInTheDocument(); // and it left the pending list
  });

  it('reviewing the last pending ticket shows the empty state', async () => {
    const only = makeTicket({ subject: 'Only one' });
    start([only], `/queue?ticket=${only.reference}`);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Reject' }));
    expect(await screen.findByText('Nothing waiting. The queue is clear.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(`Rejected ${only.reference}. The queue is clear.`);
    expect(await screen.findByText('Select a ticket to see it.')).toBeInTheDocument();
  });

  it('Edit turns the reply into a labelled textarea prefilled with the draft; Save sends action=edit with the edited text exactly', async () => {
    const t = makeTicket({ suggested_reply: 'Original draft' });
    const { gateway } = start([t], `/queue?ticket=${t.reference}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const box = screen.getByLabelText('Reply to the customer');
    expect(box).toHaveValue('Original draft');
    await user.clear(box);
    await user.type(box, 'My own reply <b>x</b>');
    await user.click(screen.getByRole('button', { name: 'Save edited reply' }));
    await waitFor(() => expect(reviewCalls(gateway)).toHaveLength(1));
    expect(reviewCalls(gateway)[0]?.body).toEqual({ action: 'edit', edited_reply: 'My own reply <b>x</b>' });
  });

  it('Save is disabled while the edited reply is blank, and Cancel goes back to the draft', async () => {
    const t = makeTicket({ suggested_reply: null });
    start([t], `/queue?ticket=${t.reference}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('button', { name: 'Save edited reply' })).toBeDisabled();
    await user.type(screen.getByLabelText('Reply to the customer'), '   ');
    expect(screen.getByRole('button', { name: 'Save edited reply' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText('No draft. Edit to write the reply yourself, or reject.')).toBeInTheDocument();
  });

  it('Reject sends action=reject with the note', async () => {
    const t = makeTicket();
    const { gateway } = start([t], `/queue?ticket=${t.reference}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Review note (optional)'), 'spam');
    await user.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(reviewCalls(gateway)).toHaveLength(1));
    expect(reviewCalls(gateway)[0]?.body).toEqual({ action: 'reject', note: 'spam' });
  });

  it('a 409 says "Already reviewed by <name>" (from a refetch) and refreshes, never a generic error', async () => {
    const t = makeTicket();
    const { gateway } = start([t], `/queue?ticket=${t.reference}`);
    gateway.state.conflictWith = { id: 'user:9', name: 'Grace Hopper' };
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Approve draft' }));
    expect(await screen.findByText('Already reviewed by Grace Hopper')).toBeInTheDocument();
    expect(screen.queryByText(/Could not save/)).not.toBeInTheDocument();
    // the panel now shows the ticket as it is: reviewed, by whom, without the action buttons
    await waitFor(() => expect(within(detail()).queryByRole('button', { name: 'Approve draft' })).not.toBeInTheDocument());
    expect(within(detail()).getByText(/Reviewed by Grace Hopper/)).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /Pending\s*0/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Approved\s*1/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: new RegExp(t.subject) })).not.toBeInTheDocument(); // gone from the pending list
  });

  it('a server error shows a plain message and keeps the ticket open for another try', async () => {
    const t = makeTicket();
    const { gateway } = start([t], `/queue?ticket=${t.reference}`);
    server.use(http.post('/api/tickets/:id/review', () => HttpResponse.json({}, { status: 503 })));
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Approve draft' }));
    expect(await screen.findByText('Could not save the review. Please try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve draft' })).toBeEnabled();
    expect(gateway.state.tickets[0]?.status).toBe('pending_review');
  });
});

describe('AI cost line', () => {
  it('shows the estimated cost and tokens in the panel', async () => {
    const t = makeTicket({ ai_cost_usd: 0.01234, ai_usage: { total_tokens: 4210, estimated_cost_usd: 0.01234 } });
    start([t], `/queue?ticket=${t.reference}`);
    const panel = await screen.findByRole('article');
    expect(within(panel).getByText('AI cost (estimate): $0.0123 · 4,210 tokens')).toBeInTheDocument();
  });

  it('shows nothing for a ticket from before cost tracking', async () => {
    const t = makeTicket({ ai_cost_usd: null, ai_usage: null });
    start([t], `/queue?ticket=${t.reference}`);
    const panel = await screen.findByRole('article');
    expect(within(panel).queryByText(/AI cost/)).not.toBeInTheDocument();
  });

  it('shows tokens alone when the model had no price', async () => {
    const t = makeTicket({ ai_cost_usd: null, ai_usage: { total_tokens: 99, estimated_cost_usd: null } });
    start([t], `/queue?ticket=${t.reference}`);
    const panel = await screen.findByRole('article');
    expect(within(panel).getByText('AI cost (estimate): 99 tokens')).toBeInTheDocument();
  });
});

describe('reviewed tickets', () => {
  it('show the decision, the final reply, the note and "Reviewed by <name>, <time>"', async () => {
    const t = makeTicket({
      status: 'edited', final_reply: 'The reply that was sent', review_note: 'tone fixed',
      reviewed_by: { id: 'user:1', name: 'Ọbiọma Ụzọ' }, reviewed_at: '2026-11-23T10:00:00.000Z',
    });
    start([t], `/queue?tab=edited&ticket=${t.reference}`);
    const panel = await screen.findByRole('article');
    expect(within(panel).getByText('Decision: Edited')).toBeInTheDocument();
    expect(within(panel).getByText('The reply that was sent')).toBeInTheDocument();
    expect(within(panel).getByText('tone fixed')).toBeInTheDocument();
    expect(within(panel).getByText(/Reviewed by Ọbiọma Ụzọ, /)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Approve draft' })).not.toBeInTheDocument();
  });

  it('a ticket reviewed before reviewers were recorded says "Reviewer unknown"', async () => {
    const t = makeTicket({ status: 'rejected', reviewed_by: null, reviewed_at: '2026-11-23T10:00:00.000Z' });
    start([t], `/queue?tab=rejected&ticket=${t.reference}`);
    expect(await screen.findByText(/Reviewer unknown/)).toBeInTheDocument();
    expect(screen.getByText('No reply was sent (rejected).')).toBeInTheDocument();
  });
});

describe('refreshing', () => {
  it('a ticket someone else rejected: opening it (list says Pending, the ticket says Rejected) updates the list and the counts', async () => {
    const t = makeTicket({ subject: 'Taken by another reviewer' });
    const other = makeTicket({ subject: 'Still waiting' });
    const { gateway } = start([t, other]);
    await screen.findByText('Taken by another reviewer'); // the list loaded: Pending
    expect(await screen.findByRole('tab', { name: /Pending\s*2/ })).toBeInTheDocument();
    // in the other window the ticket was rejected: only the server knows, this window's list and counts are stale
    Object.assign(gateway.state.tickets[0]!, { status: 'rejected', reviewed_by: { id: 'user:2', name: 'Grace Hopper' }, reviewed_at: new Date().toISOString() });

    await userEvent.setup().click(screen.getByRole('button', { name: /Taken by another reviewer/ }));
    expect(await within(await screen.findByRole('article')).findByText('Decision: Rejected')).toBeInTheDocument();
    // the list and the counts caught up without a reload
    await waitFor(() => expect(screen.queryByRole('button', { name: /Taken by another reviewer/ })).not.toBeInTheDocument());
    expect(await screen.findByRole('tab', { name: /Pending\s*1/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Rejected\s*1/ })).toBeInTheDocument();
  });

  it('window focus: the open ticket changed under us (Pending -> Rejected), and the list and counts follow', async () => {
    const t = makeTicket({ subject: 'Watch me' });
    const { gateway } = start([t, makeTicket({ subject: 'Other' })], `/queue?ticket=${t.reference}`);
    expect(await within(await screen.findByRole('article')).findByRole('button', { name: 'Approve draft' })).toBeInTheDocument();
    Object.assign(gateway.state.tickets[0]!, { status: 'rejected', reviewed_by: { id: 'user:2', name: 'Grace Hopper' }, reviewed_at: new Date().toISOString() });

    window.dispatchEvent(new Event('focus')); // clicking back into this window (no visibilitychange for a side-by-side window)

    expect(await within(screen.getByRole('article')).findByText('Decision: Rejected')).toBeInTheDocument();
    expect(await screen.findByRole('tab', { name: /Rejected\s*1/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Watch me/ })).not.toBeInTheDocument());
  });

  it('the counts refetch when the window gets focus again', async () => {
    const { gateway } = start([makeTicket()]);
    expect(await screen.findByRole('tab', { name: /Pending\s*1/ })).toBeInTheDocument();
    gateway.state.tickets.push(makeTicket(), makeTicket());
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    window.dispatchEvent(new Event('visibilitychange')); // TanStack Query listens on window
    expect(await screen.findByRole('tab', { name: /Pending\s*3/ })).toBeInTheDocument();
  });
});

describe('relativeTime', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  it.each([
    ['2026-11-23T11:59:30Z', 'just now'],
    ['2026-11-23T11:55:00Z', '5 min ago'],
    ['2026-11-23T09:00:00Z', '3 h ago'],
    ['2026-11-22T11:00:00Z', '1 day ago'],
    ['2026-11-20T12:00:00Z', '3 days ago'],
    ['2026-11-23T12:05:00Z', 'just now'], // a clock a little ahead is not "-5 min"
  ])('%s -> %s', (iso, expected) => {
    expect(relativeTime(iso, now)).toBe(expected);
  });
});

describe('auto-handled tickets: Approve and send', () => {
  const auto = (over = {}) => makeTicket({ status: 'triaged', needs_human_review: false, review_reason: null, customer_email: 'ada@example.com', ...over });

  it('shows the draft and an "Approve and send" button with the optional note', async () => {
    const t = auto({ suggested_reply: 'Auto draft' });
    start([t], `/queue?tab=auto&ticket=${t.reference}`);
    const panel = await screen.findByRole('article');
    expect(within(panel).getByText('Auto draft')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Approve and send' })).toBeEnabled();
    expect(within(panel).getByLabelText('Review note (optional)')).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument(); // approve only
  });

  it('with no draft there is no button', async () => {
    const t = auto({ suggested_reply: null });
    start([t], `/queue?tab=auto&ticket=${t.reference}`);
    await screen.findByRole('article');
    expect(screen.queryByRole('button', { name: 'Approve and send' })).not.toBeInTheDocument();
  });

  it('clicking it sends action=approve (with the note), moves the ticket to Approved, refreshes the list and counts, and shows "Sending…"', async () => {
    const t = auto({ subject: 'One click' });
    const { gateway } = start([t, auto({ subject: 'Another auto' })], `/queue?tab=auto&ticket=${t.reference}`);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('Review note (optional)'), 'ok to send');
    await user.click(screen.getByRole('button', { name: 'Approve and send' }));

    await waitFor(() => expect(reviewCalls(gateway)).toHaveLength(1));
    expect(reviewCalls(gateway)[0]?.body).toEqual({ action: 'approve', note: 'ok to send' });
    expect(await screen.findByRole('tab', { name: /Approved\s*1/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Auto-handled\s*1/ })).toBeInTheDocument(); // the other one is still there
    expect(await within(await screen.findByRole('article')).findByText('Decision: Approved')).toBeInTheDocument();
    expect(await screen.findByText('Sending…')).toBeInTheDocument();
  });
});

describe('delivery status of an approved reply', () => {
  const approved = (over = {}) => makeTicket({ status: 'approved', final_reply: 'Sent text', reviewed_by: { id: 'user:1', name: 'Grace' }, reviewed_at: '2026-11-23T10:00:00.000Z', customer_email: 'ada@example.com', ...over });
  const withDelivery = (t: ReturnType<typeof makeTicket>, d: object) => {
    const g = start([t], `/queue?tab=approved&ticket=${t.reference}`);
    g.gateway.state.deliveries.set(t.ticket_id, { status: 'queued', attempts: 0, sent_at: null, error: null, ...d });
    return g;
  };

  it('sent: "Reply sent <time>"', async () => {
    const t = approved();
    withDelivery(t, { status: 'sent', attempts: 1, sent_at: '2026-11-23T10:05:00.000Z' });
    expect(await screen.findByText(/^Reply sent /)).toBeInTheDocument();
  });

  it('skipped_no_email: "No customer email, so no reply was sent."', async () => {
    const t = approved({ customer_email: null });
    withDelivery(t, { status: 'skipped_no_email' });
    expect(await screen.findByText('No customer email, so no reply was sent.')).toBeInTheDocument();
  });

  it('none (mail off, or an old approval): nothing is shown', async () => {
    const t = approved();
    start([t], `/queue?tab=approved&ticket=${t.reference}`);
    await screen.findByText('Decision: Approved');
    await waitFor(() => expect(screen.queryByText(/Sending|Reply sent|No customer email|failed/i)).not.toBeInTheDocument());
  });

  it('queued: "Sending…", asked again until it is final, then "Reply sent"', async () => {
    deliveryPolling.ms = 40;
    try {
      const t = approved();
      const { gateway } = withDelivery(t, { status: 'queued' });
      expect(await screen.findByText('Sending…')).toBeInTheDocument();
      gateway.state.deliveries.set(t.ticket_id, { status: 'sent', attempts: 1, sent_at: '2026-11-23T10:05:00.000Z', error: null });
      expect(await screen.findByText(/^Reply sent /)).toBeInTheDocument();
      const asked = gateway.state.calls.filter((c) => c.path.endsWith('/delivery')).length;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(gateway.state.calls.filter((c) => c.path.endsWith('/delivery')).length).toBe(asked); // polling stopped when final
    } finally {
      deliveryPolling.ms = 5_000;
    }
  });

  it('failed: "Sending failed" with the reason and a "Retry sending" button that requeues it', async () => {
    deliveryPolling.ms = 40;
    try {
      const t = approved();
      const { gateway } = withDelivery(t, { status: 'failed', attempts: 8, error: 'mail server unreachable' });
      expect(await screen.findByText('Sending failed')).toBeInTheDocument();
      expect(screen.getByText('mail server unreachable')).toBeInTheDocument();
      await userEvent.setup().click(screen.getByRole('button', { name: 'Retry sending' }));
      expect(await screen.findByText('Sending…')).toBeInTheDocument();
      expect(gateway.state.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/delivery/retry'))).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Retry sending' })).not.toBeInTheDocument();
    } finally {
      deliveryPolling.ms = 5_000;
    }
  });

  it('rejected: no delivery section at all, and the delivery is never even asked for', async () => {
    const t = makeTicket({ status: 'rejected', reviewed_by: { id: 'user:1', name: 'Grace' }, reviewed_at: '2026-11-23T10:00:00.000Z', customer_email: 'ada@example.com' });
    const { gateway } = start([t], `/queue?tab=rejected&ticket=${t.reference}`);
    await screen.findByText('Decision: Rejected');
    expect(screen.queryByText(/Sending|Reply sent|Sending failed/)).not.toBeInTheDocument();
    expect(gateway.state.calls.some((c) => c.path.endsWith('/delivery'))).toBe(false);
  });

  it('a pending ticket approved in the queue shows "Sending…" after the next ticket opens', async () => {
    const first = makeTicket({ subject: 'First', customer_email: 'ada@example.com', minutesAgo: 1 });
    start([first], `/queue?ticket=${first.reference}`);
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Approve draft' }));
    await screen.findByText(/The queue is clear/);
    // looking at it again under Approved: the delivery is queued
    await userEvent.setup().click(screen.getByRole('tab', { name: /Approved/ }));
    await userEvent.setup().click(await screen.findByRole('button', { name: /First/ }));
    expect(await screen.findByText('Sending…')).toBeInTheDocument();
  });
});

