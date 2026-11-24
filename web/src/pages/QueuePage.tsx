import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { fetchTickets, type Ticket } from '../api/tickets.js';
import { isDemo, useLogout, useMe } from '../auth/useAuth.js';
import { DemoSubmitBox } from '../queue/DemoSubmitBox.js';
import { TicketDetail } from '../queue/TicketDetail.js';
import { TicketList } from '../queue/TicketList.js';
import { STATUS_LABEL, TABS, tabFor } from '../queue/tabs.js';
import { keys, useCounts, useTicketList } from '../queue/useQueue.js';

export function QueuePage() {
  const me = useMe();
  const logout = useLogout();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [message, setMessage] = useState('');

  const tab = tabFor(params.get('tab'));
  const reference = params.get('ticket');
  const counts = useCounts();
  const list = useTicketList(tab.status);
  const tickets = list.data?.pages.flat() ?? [];

  const open = (next: { tab?: string; ticket?: string }) => setParams(next.ticket ? { tab: next.tab ?? tab.key, ticket: next.ticket } : { tab: next.tab ?? tab.key });

  /** A review was saved: refresh the lists and counts, say so, and open the next pending ticket (or show the empty queue). */
  async function reviewed(done: Ticket, wasAutoHandled: boolean) {
    await queryClient.invalidateQueries({ queryKey: keys.all });
    if (wasAutoHandled) {
      // An auto-handled ticket was approved (its draft is being emailed). It moved to Approved: show it there, so its delivery status is in view.
      setMessage(`Approved ${done.reference}.`);
      setParams({ tab: 'approved', ticket: done.reference });
      return;
    }
    let next: Ticket | undefined;
    try {
      const page = await queryClient.fetchQuery({ queryKey: [...keys.all, 'next'], queryFn: () => fetchTickets('pending_review', undefined, 5), staleTime: 0 });
      next = page.find((ticket) => ticket.ticket_id !== done.ticket_id);
    } catch {
      // The review is saved; failing to look for the next ticket just leaves nothing selected.
    }
    setMessage(`${STATUS_LABEL[done.status]} ${done.reference}. ${next ? `Opened ${next.reference}.` : 'The queue is clear.'}`);
    setParams(next ? { tab: 'pending', ticket: next.reference } : { tab: 'pending' });
  }

  return (
    <div className="min-h-screen">
      <header className="flex items-center justify-between border-b border-line bg-card px-4 py-2">
        <span className="font-semibold">TriageIQ · Review queue</span>
        <div className="flex items-center gap-3">
          <span>{me.data?.user.display_name ?? ''}</span>
          <button
            type="button"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
            className="rounded border border-line px-3 py-1 hover:bg-page focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
          >
            Log out
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[90rem] p-4">
        <p role="alert" className="min-h-5 text-danger">
          {logout.isError ? 'Could not log out. Please try again.' : ''}
        </p>
        {/* Only for the demo visitor: a real reviewer never sees this box. */}
        {isDemo(me.data) ? (
          <DemoSubmitBox
            onSent={(sentReference) => {
              setMessage(`Submitted ${sentReference}. The AI is working on it: it will appear in Pending (or Auto-handled) within a minute or two. Visible to other demo visitors until the nightly reset.`);
              void queryClient.invalidateQueries({ queryKey: keys.all });
            }}
          />
        ) : null}
        {/* Confirmations and status changes, announced by screen readers too. */}
        <p role="status" aria-live="polite" className="mb-2 min-h-5 font-medium">
          {message}
        </p>

        <div role="tablist" aria-label="Ticket status" className="mb-3 flex flex-wrap gap-1 border-b border-line">
          {TABS.map((item) => {
            const selected = item.key === tab.key;
            const count = counts.data?.[item.status];
            return (
              <button
                key={item.key}
                type="button"
                role="tab"
                id={`tab-${item.key}`}
                aria-selected={selected}
                aria-controls="queue-panel"
                onClick={() => {
                  setMessage('');
                  open({ tab: item.key });
                }}
                className={`-mb-px rounded-t border border-b-0 px-3 py-1.5 focus-visible:outline-2 focus-visible:outline-accent ${
                  selected ? 'border-line bg-card font-semibold' : 'border-transparent text-muted hover:text-ink'
                }`}
              >
                {item.label}
                {count === undefined ? '' : <span className="ml-1.5 rounded bg-page px-1.5 text-xs text-ink">{count}</span>}
              </button>
            );
          })}
        </div>

        <div id="queue-panel" role="tabpanel" aria-labelledby={`tab-${tab.key}`} className="grid gap-4 lg:grid-cols-[24rem_1fr]">
          <section aria-label={`${tab.label} tickets`}>
            {list.isPending ? (
              <p className="text-muted">Loading…</p>
            ) : list.isError ? (
              <div>
                <p role="alert">Could not load the tickets.</p>
                <button type="button" onClick={() => void list.refetch()} className="mt-2 rounded border border-line px-3 py-1 hover:bg-page">
                  Try again
                </button>
              </div>
            ) : (
              <TicketList
                tickets={tickets}
                selected={reference}
                onSelect={(ref) => open({ ticket: ref })}
                hasMore={list.hasNextPage}
                loadingMore={list.isFetchingNextPage}
                onLoadMore={() => void list.fetchNextPage()}
                emptyText={tab.key === 'pending' ? 'Nothing waiting. The queue is clear.' : 'No tickets here yet.'}
              />
            )}
          </section>

          <section aria-label="Ticket" className="rounded-lg border border-line bg-card">
            {reference ? <TicketDetail key={reference} reference={reference} onReviewed={(done, wasAutoHandled) => void reviewed(done, wasAutoHandled)} /> : <p className="p-4 text-muted">Select a ticket to see it.</p>}
          </section>
        </div>
      </main>
    </div>
  );
}

