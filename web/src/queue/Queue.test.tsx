import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { answers } from '../test/gateway.js';
import { makeTicket, queueGateway } from '../test/queueGateway.js';
import { renderApp } from '../test/render.js';
import { server } from '../test/server.js';
import { relativeTime } from '../lib/time.js';

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
