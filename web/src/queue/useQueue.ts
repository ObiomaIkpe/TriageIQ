import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { cursorAfter, fetchCounts, fetchDelivery, fetchTicket, fetchTickets, PAGE_SIZE, type Ticket, type TicketStatus } from '../api/tickets.js';

/** The list and the counts refetch every 30 s and when the window gets focus again. */
export const REFRESH_MS = 30_000;
const refresh = { refetchInterval: REFRESH_MS, refetchOnWindowFocus: true, staleTime: 0 } as const;

export const keys = {
  all: ['tickets'] as const,
  list: (status: TicketStatus) => ['tickets', 'list', status] as const,
  counts: ['tickets', 'counts'] as const,
  detail: (reference: string) => ['tickets', 'detail', reference] as const,
  delivery: (ticketId: string) => ['tickets', 'delivery', ticketId] as const,
};

export function useCounts() {
  return useQuery({ queryKey: keys.counts, queryFn: fetchCounts, ...refresh });
}

/** Pages of tickets, newest first; "Load more" asks for the page after the last ticket seen (a keyset cursor, so no repeats). */
export function useTicketList(status: TicketStatus) {
  return useInfiniteQuery({
    queryKey: keys.list(status),
    queryFn: ({ pageParam }) => fetchTickets(status, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => (last.length === PAGE_SIZE ? cursorAfter(last[last.length - 1]!) : undefined),
    ...refresh,
  });
}

/**
 * The open ticket. Whenever what we now know about its status differs from what the lists show (or from what we knew a
 * moment ago), the ticket lists and the counts are refreshed: a ticket someone else reviewed must not stay "Pending" in
 * the list and in the tab counts while its panel says "Rejected". This covers every way the status can change under us:
 * a refetch (timer or focus), our own review, and a 409 (all of them update this query's data).
 */
export function useTicket(reference: string | null) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: keys.detail(reference ?? ''),
    queryFn: () => fetchTicket(reference as string),
    enabled: reference !== null,
    ...refresh,
  });

  const known = useRef<{ id: string; status: TicketStatus } | null>(null);
  const ticket = query.data;
  useEffect(() => {
    if (!ticket) return;
    const before = known.current;
    const changedUnderUs = before !== null && before.id === ticket.ticket_id && before.status !== ticket.status;
    known.current = { id: ticket.ticket_id, status: ticket.status };
    if (changedUnderUs || listsDisagree(queryClient.getQueriesData<InfiniteData<Ticket[]>>({ queryKey: ['tickets', 'list'] }), ticket)) {
      void queryClient.invalidateQueries({ queryKey: ['tickets', 'list'] });
      void queryClient.invalidateQueries({ queryKey: keys.counts });
    }
  }, [ticket, queryClient]);

  return query;
}

/** True if some cached list holds this ticket under a different status than the ticket itself now has. */
function listsDisagree(lists: [unknown, InfiniteData<Ticket[]> | undefined][], ticket: Ticket): boolean {
  return lists.some(([, data]) => data?.pages.some((page) => page.some((t) => t.ticket_id === ticket.ticket_id && t.status !== ticket.status)));
}

/** While an email is "queued" the status is asked again every 5 seconds, and the polling stops by itself once it is final. */
export const deliveryPolling = { ms: 5_000 }; // an object, so a test can shorten it

export function useDelivery(ticketId: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.delivery(ticketId),
    queryFn: () => fetchDelivery(ticketId),
    enabled,
    refetchInterval: (query) => (query.state.data?.status === 'queued' ? deliveryPolling.ms : false),
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
}

