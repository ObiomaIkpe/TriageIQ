import type { TicketStatus } from '../api/tickets.js';

/** The tabs, in order. `key` is what the URL carries (?tab=pending). */
export const TABS = [
  { key: 'pending', status: 'pending_review', label: 'Pending' },
  { key: 'approved', status: 'approved', label: 'Approved' },
  { key: 'edited', status: 'edited', label: 'Edited' },
  { key: 'rejected', status: 'rejected', label: 'Rejected' },
  // Tickets the AI handled without needing a reviewer (status "triaged").
  { key: 'auto', status: 'triaged', label: 'Auto-handled' },
] as const satisfies readonly { key: string; status: TicketStatus; label: string }[];

export type TabKey = (typeof TABS)[number]['key'];

export const DEFAULT_TAB: TabKey = 'pending';

export function tabFor(key: string | null) {
  return TABS.find((tab) => tab.key === key) ?? TABS[0];
}

export const STATUS_LABEL: Record<TicketStatus, string> = {
  pending_review: 'Pending',
  approved: 'Approved',
  edited: 'Edited',
  rejected: 'Rejected',
  triaged: 'Auto-handled',
};

/** Badge colours (text and background pairs checked for contrast in theme.test.ts). */
export const STATUS_STYLE: Record<TicketStatus, string> = {
  pending_review: 'bg-warn-bg text-warn-ink',
  approved: 'bg-ok-bg text-ok-ink',
  edited: 'bg-info-bg text-info-ink',
  rejected: 'bg-bad-bg text-bad-ink',
  triaged: 'bg-page text-ink border border-line',
};
