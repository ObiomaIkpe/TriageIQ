import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { cursorAfter, fetchCounts, fetchTicket, fetchTickets, PAGE_SIZE, type TicketStatus } from '../api/tickets.js';

/** The list and the counts refetch every 30 s and when the window gets focus again. */
export const REFRESH_MS = 30_000;
const refresh = { refetchInterval: REFRESH_MS, refetchOnWindowFocus: true, staleTime: 0 } as const;

export const keys = {
  all: ['tickets'] as const,
  list: (status: TicketStatus) => ['tickets', 'list', status] as const,
  counts: ['tickets', 'counts'] as const,
  detail: (reference: string) => ['tickets', 'detail', reference] as const,
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

export function useTicket(reference: string | null) {
  return useQuery({
    queryKey: keys.detail(reference ?? ''),
    queryFn: () => fetchTicket(reference as string),
    enabled: reference !== null,
    ...refresh,
  });
}
