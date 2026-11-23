import { http, HttpResponse } from 'msw';
import { PAGE_SIZE, STATUSES, type Counts, type Delivery, type Ticket } from '../api/tickets.js';

let serial = 0;

/** A ticket with sensible defaults. `minutesAgo` sets created_at; ids and references are unique per call. */
export function makeTicket(overrides: Partial<Ticket> & { minutesAgo?: number } = {}): Ticket {
  serial += 1;
  const { minutesAgo = serial, ...rest } = overrides;
  const n = String(serial).padStart(4, '0');
  return {
    ticket_id: `00000000-0000-4000-8000-00000000${n}`,
    reference: `TKT-AB${n.replace(/[01]/g, '2')}`,
    status: 'pending_review',
    subject: `Subject ${n}`,
    body: `Message body ${n}`,
    customer_id: null,
    customer_name: null,
    customer_email: null,
    category: 'account',
    urgency: 'high',
    confidence: 0.42,
    routing_target: 'account-management',
    suggested_reply: `Draft reply ${n}`,
    kb_sources: [{ topic: 'Account lockout', content: 'Lockout clears after 1 hour.', distance: 0.33 }],
    needs_human_review: true,
    review_reason: `Reason ${n}`,
    final_reply: null,
    review_note: null,
    reviewed_at: null,
    reviewed_by: null,
    created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    ...rest,
  };
}

/**
 * A fake gateway for the queue: lists (status filter, newest first, keyset cursor), counts, reads by reference, and reviews.
 * `state.tickets` can be changed by a test at any time; `calls` records every request.
 */
export function queueGateway(initial: Ticket[]) {
  const state = {
    tickets: [...initial],
    calls: [] as { method: string; path: string; search: string; body?: unknown }[],
    /** Set to make the next review answer 409 (someone else got there first), as this reviewer. */
    conflictWith: undefined as { id: string; name: string } | undefined,
    /** The email delivery of each ticket id (absent: none). A review of a ticket with an email makes it queued, like the gateway. */
    deliveries: new Map<string, Delivery>(),
  };
  const newestFirst = () => [...state.tickets].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.ticket_id.localeCompare(a.ticket_id));
  const counts = (): Counts => Object.fromEntries(STATUSES.map((s) => [s, state.tickets.filter((t) => t.status === s).length])) as Counts;

  const handlers = [
    http.get('/api/tickets/counts', ({ request }) => {
      state.calls.push({ method: 'GET', path: '/tickets/counts', search: new URL(request.url).search });
      return HttpResponse.json(counts());
    }),
    http.get('/api/tickets', ({ request }) => {
      const url = new URL(request.url);
      state.calls.push({ method: 'GET', path: '/tickets', search: url.search });
      const status = url.searchParams.get('status');
      const cursor = url.searchParams.get('cursor');
      const limit = Number(url.searchParams.get('limit') ?? 50);
      let items = newestFirst().filter((t) => !status || t.status === status);
      if (cursor) {
        const [at, id] = cursor.split('|');
        items = items.filter((t) => t.created_at < at! || (t.created_at === at && t.ticket_id < id!));
      }
      return HttpResponse.json(items.slice(0, limit));
    }),
    http.get('/api/tickets/:id/delivery', ({ params }) => {
      state.calls.push({ method: 'GET', path: `/tickets/${String(params.id)}/delivery`, search: '' });
      return HttpResponse.json(state.deliveries.get(String(params.id)) ?? { status: 'none', attempts: 0, sent_at: null, error: null });
    }),
    http.post('/api/tickets/:id/delivery/retry', ({ params }) => {
      state.calls.push({ method: 'POST', path: `/tickets/${String(params.id)}/delivery/retry`, search: '' });
      const current = state.deliveries.get(String(params.id));
      if (current?.status !== 'failed') return HttpResponse.json({ detail: 'Only a failed delivery can be retried' }, { status: 409 });
      const fresh: Delivery = { status: 'queued', attempts: 0, sent_at: null, error: null };
      state.deliveries.set(String(params.id), fresh);
      return HttpResponse.json(fresh);
    }),
    http.get('/api/tickets/reference/:reference', ({ params }) => {
      const ticket = state.tickets.find((t) => t.reference === params.reference);
      return ticket ? HttpResponse.json(ticket) : HttpResponse.json({ detail: 'Ticket not found' }, { status: 404 });
    }),
    http.post('/api/tickets/:id/review', async ({ params, request }) => {
      const body = (await request.json()) as { action: 'approve' | 'edit' | 'reject'; edited_reply?: string; note?: string };
      state.calls.push({ method: 'POST', path: `/tickets/${String(params.id)}/review`, search: '', body });
      const ticket = state.tickets.find((t) => t.ticket_id === params.id);
      if (!ticket) return HttpResponse.json({ detail: 'Ticket not found' }, { status: 404 });
      const triagedApproval = ticket.status === 'triaged' && body.action === 'approve' && !!ticket.suggested_reply;
      if ((ticket.status !== 'pending_review' && !triagedApproval) || state.conflictWith) {
        if (state.conflictWith) {
          Object.assign(ticket, { status: 'approved', reviewed_by: state.conflictWith, reviewed_at: new Date().toISOString(), final_reply: ticket.suggested_reply });
        }
        return HttpResponse.json({ detail: 'Ticket is not waiting for a review' }, { status: 409 });
      }
      Object.assign(ticket, {
        status: { approve: 'approved', edit: 'edited', reject: 'rejected' }[body.action],
        final_reply: body.action === 'approve' ? ticket.suggested_reply : body.action === 'edit' ? (body.edited_reply ?? null) : null,
        review_note: body.note ?? null,
        reviewed_at: new Date().toISOString(),
        reviewed_by: { id: 'user:1', name: 'Ọbiọma Ụzọ' },
      });
      if (body.action !== 'reject' && ticket.customer_email) {
        state.deliveries.set(ticket.ticket_id, { status: 'queued', attempts: 0, sent_at: null, error: null });
      }
      return HttpResponse.json(ticket);
    }),
  ];
  return { state, handlers, pageSize: PAGE_SIZE };
}
