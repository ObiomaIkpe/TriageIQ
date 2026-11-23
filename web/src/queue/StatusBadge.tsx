import type { TicketStatus } from '../api/tickets.js';
import { STATUS_LABEL, STATUS_STYLE } from './tabs.js';

export function StatusBadge({ status }: { status: TicketStatus }) {
  return <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}>{STATUS_LABEL[status]}</span>;
}
