import type { Ticket } from '../api/tickets.js';
import { exactTime, relativeTime } from '../lib/time.js';
import { StatusBadge } from './StatusBadge.js';

interface Props {
  tickets: Ticket[];
  selected: string | null;
  onSelect: (reference: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  emptyText: string;
}

/** The cards. Every text on them is customer- or model-written, so it is only ever a React text node. */
export function TicketList({ tickets, selected, onSelect, hasMore, loadingMore, onLoadMore, emptyText }: Props) {
  if (tickets.length === 0) return <p className="rounded-lg border border-line bg-card p-4 text-muted">{emptyText}</p>;
  return (
    <div>
      <ul className="flex flex-col gap-2">
        {tickets.map((ticket) => {
          const isSelected = ticket.reference === selected;
          return (
            <li key={ticket.ticket_id}>
              <button
                type="button"
                onClick={() => onSelect(ticket.reference)}
                aria-current={isSelected ? 'true' : undefined}
                className={`w-full rounded-lg border p-3 text-left focus-visible:outline-2 focus-visible:outline-accent ${
                  isSelected ? 'border-accent bg-accent-soft' : 'border-line bg-card hover:bg-page'
                }`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs text-muted">{ticket.reference}</span>
                  <StatusBadge status={ticket.status} />
                </span>
                <span className="mt-1 block font-medium break-words">{ticket.subject}</span>
                {ticket.review_reason ? <span className="mt-1 block text-muted break-words">{ticket.review_reason}</span> : null}
                <span className="mt-1 block text-xs text-muted">
                  {ticket.category} · {ticket.urgency} ·{' '}
                  <time dateTime={ticket.created_at} title={exactTime(ticket.created_at)}>
                    {relativeTime(ticket.created_at)}
                  </time>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {hasMore ? (
        <button
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
          className="mt-3 w-full rounded border border-line bg-card px-3 py-2 hover:bg-page focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
        >
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </div>
  );
}
