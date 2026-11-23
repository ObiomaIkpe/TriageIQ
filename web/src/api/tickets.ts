import { api } from './client.js';

export const STATUSES = ['triaged', 'pending_review', 'approved', 'edited', 'rejected'] as const;
export type TicketStatus = (typeof STATUSES)[number];

export interface KbSource {
  topic: string;
  content: string;
  distance: number;
}

/** A ticket as the gateway returns it (Python's TicketRecord). Every text field here is customer- or model-written: show it as text only. */
export interface Ticket {
  ticket_id: string;
  reference: string;
  status: TicketStatus;
  subject: string;
  body: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  category: string;
  urgency: string;
  confidence: number;
  routing_target: string;
  suggested_reply: string | null;
  kb_sources: KbSource[];
  needs_human_review: boolean;
  review_reason: string | null;
  final_reply: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  reviewed_by: { id: string; name: string } | null;
  created_at: string;
  /** What the model calls for this ticket used, and an ESTIMATED cost (US dollars). Missing or null on tickets from before cost tracking. */
  ai_usage?: { total_tokens?: number; estimated_cost_usd?: number | null } | null;
  ai_cost_usd?: number | null;
}

/** "AI cost (estimate): $0.0123 · 4,210 tokens", or null when the ticket has no usage recorded. */
export function aiCostLine(ticket: Pick<Ticket, 'ai_usage' | 'ai_cost_usd'>): string | null {
  const tokens = ticket.ai_usage?.total_tokens;
  if (typeof tokens !== 'number') return null;
  const cost = ticket.ai_cost_usd;
  const money = typeof cost === 'number' ? `$${cost.toFixed(4)} · ` : '';
  return `AI cost (estimate): ${money}${tokens.toLocaleString('en-US')} tokens`;
}

export type Counts = Record<TicketStatus, number>;

export const PAGE_SIZE = 20;

/** The keyset cursor for the page after `last`: exactly its created_at and ticket_id (what the API expects back). */
export const cursorAfter = (last: Ticket): string => `${last.created_at}|${last.ticket_id}`;

export function fetchTickets(status: TicketStatus, cursor?: string, limit = PAGE_SIZE): Promise<Ticket[]> {
  const query = new URLSearchParams({ status, limit: String(limit) });
  if (cursor) query.set('cursor', cursor);
  return api<Ticket[]>(`/tickets?${query.toString()}`);
}

export const fetchCounts = (): Promise<Counts> => api<Counts>('/tickets/counts');

export const fetchTicket = (reference: string): Promise<Ticket> =>
  api<Ticket>(`/tickets/reference/${encodeURIComponent(reference)}`);

export interface ReviewBody {
  action: 'approve' | 'edit' | 'reject';
  edited_reply?: string;
  note?: string;
}

export const reviewTicket = (ticketId: string, body: ReviewBody): Promise<Ticket> =>
  api<Ticket>(`/tickets/${encodeURIComponent(ticketId)}/review`, { method: 'POST', body });

export type DeliveryState = 'none' | 'queued' | 'sent' | 'failed' | 'skipped_no_email';

/** How the email of an approved reply is going. `error` is a short generic phrase from the gateway (never an address). */
export interface Delivery {
  status: DeliveryState;
  attempts: number;
  sent_at: string | null;
  error: string | null;
}

export const fetchDelivery = (ticketId: string): Promise<Delivery> => api<Delivery>(`/tickets/${encodeURIComponent(ticketId)}/delivery`);

export const retryDelivery = (ticketId: string): Promise<Delivery> =>
  api<Delivery>(`/tickets/${encodeURIComponent(ticketId)}/delivery/retry`, { method: 'POST' });

