import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { ApiError, ConflictError } from '../api/errors.js';
import { fetchTicket, retryDelivery, reviewTicket, type Delivery, type ReviewBody, type Ticket } from '../api/tickets.js';
import { exactTime } from '../lib/time.js';
import { StatusBadge } from './StatusBadge.js';
import { STATUS_LABEL } from './tabs.js';
import { keys, useDelivery, useTicket } from './useQueue.js';

/** Customer- and model-written text, shown exactly as written: a React text node (never HTML), line breaks kept, long words wrapped. */
function Plain({ text, className = '' }: { text: string; className?: string }) {
  return <p className={`break-words whitespace-pre-wrap ${className}`}>{text}</p>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-4">
      <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
      {children}
    </section>
  );
}

interface Props {
  reference: string;
  /** Called after a review was saved. `wasAutoHandled`: the ticket had been auto-handled (status triaged) before this approval. */
  onReviewed: (ticket: Ticket, wasAutoHandled: boolean) => void;
}

export function TicketDetail({ reference, onReviewed }: Props) {
  const query = useTicket(reference);
  if (query.isPending) return <p className="p-4 text-muted">Loading…</p>;
  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return (
      <div className="p-4">
        <p role="alert">{notFound ? 'Ticket not found.' : 'Could not load this ticket.'}</p>
        {notFound ? null : (
          <button type="button" onClick={() => void query.refetch()} className="mt-2 rounded border border-line px-3 py-1 hover:bg-page">
            Try again
          </button>
        )}
      </div>
    );
  }
  // key: switching ticket forgets the half-typed reply and note of the previous one
  return <TicketView key={query.data.ticket_id} ticket={query.data} onReviewed={onReviewed} />;
}

function TicketView({ ticket, onReviewed }: { ticket: Ticket; onReviewed: Props['onReviewed'] }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [reply, setReply] = useState(ticket.suggested_reply ?? '');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState('');
  const ids = { reply: useId(), note: useId(), noDraft: useId() };

  const review = useMutation<Ticket, ApiError, ReviewBody>({
    mutationFn: (body) => reviewTicket(ticket.ticket_id, body),
    onMutate: () => setProblem(''),
    onSuccess: (saved) => {
      queryClient.setQueryData(keys.detail(saved.reference), saved);
      onReviewed(saved, ticket.status === 'triaged');
    },
    onError: async (error) => {
      if (error instanceof ConflictError) {
        // Someone got there first. Look at the ticket as it is now and say who, then refresh everything.
        try {
          const fresh = await queryClient.fetchQuery({ queryKey: keys.detail(ticket.reference), queryFn: () => fetchTicket(ticket.reference), staleTime: 0 });
          setProblem(fresh.reviewed_by ? `Already reviewed by ${fresh.reviewed_by.name}` : 'Already reviewed (reviewer unknown)');
        } catch {
          setProblem('Already reviewed');
        }
        void queryClient.invalidateQueries({ queryKey: keys.all });
        return;
      }
      const rejected = error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 403;
      setProblem(rejected ? 'The review was not accepted. Check the reply and try again.' : 'Could not save the review. Please try again.');
    },
  });

  const pending = ticket.status === 'pending_review';
  // An auto-handled ticket (the AI finished it without a reviewer) can be approved in one click, which sends its draft.
  const autoApprovable = ticket.status === 'triaged' && (ticket.suggested_reply ?? '').trim() !== '';
  const hasDraft = (ticket.suggested_reply ?? '').trim() !== '';
  const busy = review.isPending;
  const cleanNote = note.trim() === '' ? {} : { note: note.trim() };
  const confidence = `${Math.round(ticket.confidence * 100)}%`;

  return (
    <article className="p-4" aria-label={`Ticket ${ticket.reference}`}>
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-mono text-base font-semibold">{ticket.reference}</h2>
          <StatusBadge status={ticket.status} />
          <span className="text-muted">Received {exactTime(ticket.created_at)}</span>
        </div>
        {ticket.customer_name || ticket.customer_email ? (
          <p className="mt-1 break-words">
            {ticket.customer_name ?? ''}
            {ticket.customer_name && ticket.customer_email ? ' · ' : ''}
            {ticket.customer_email ?? ''}
          </p>
        ) : null}
      </header>

      {/* Outside the actions block on purpose: after "Already reviewed by ..." the ticket refreshes into a reviewed one, and the message must stay. */}
      <p role="alert" className="mt-2 min-h-5 font-medium text-danger">
        {problem}
      </p>

      <Section title="Subject">
        <Plain text={ticket.subject} className="font-medium" />
      </Section>
      <Section title="Message">
        <Plain text={ticket.body} />
      </Section>

      <Section title="Why it is here">
        <Plain text={ticket.review_reason ?? (pending ? 'No reason recorded.' : 'No review was needed.')} />
      </Section>

      <Section title="Classification">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5">
          <dt className="text-muted">Category</dt>
          <dd>{ticket.category}</dd>
          <dt className="text-muted">Urgency</dt>
          <dd>{ticket.urgency}</dd>
          <dt className="text-muted">Routed to</dt>
          <dd>{ticket.routing_target}</dd>
          <dt className="text-muted">Confidence</dt>
          <dd>{confidence}</dd>
        </dl>
      </Section>

      <Section title="Knowledge base">
        {ticket.kb_sources.length === 0 ? (
          <p>No article matched, so any reply must come from a person.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {ticket.kb_sources.map((source, index) => (
              <li key={`${source.topic}-${index}`} className="rounded border border-line bg-page p-2">
                <p className="font-medium break-words">
                  {source.topic} <span className="font-normal text-muted">· distance {source.distance.toFixed(2)}</span>
                </p>
                <Plain text={source.content} className="mt-1" />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {editing ? (
        <Section title="Reply">
          <label htmlFor={ids.reply} className="mb-1 block font-medium">
            Reply to the customer
          </label>
          <textarea
            id={ids.reply}
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            rows={8}
            className="w-full rounded border border-line bg-card p-2 focus-visible:outline-2 focus-visible:outline-accent"
          />
        </Section>
      ) : (
        <Section title={pending || ticket.status === 'triaged' ? 'Draft reply' : 'Draft reply (AI)'}>
          {hasDraft ? <Plain text={ticket.suggested_reply as string} /> : <p>No draft. Edit to write the reply yourself, or reject.</p>}
        </Section>
      )}

      {autoApprovable ? (
        <section className="mt-4 border-t border-line pt-4">
          <label htmlFor={ids.note} className="mb-1 block font-medium">
            Review note (optional)
          </label>
          <textarea
            id={ids.note}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            className="mb-3 w-full rounded border border-line bg-card p-2 focus-visible:outline-2 focus-visible:outline-accent"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => review.mutate({ action: 'approve', ...cleanNote })}
            className="rounded bg-accent px-3 py-1.5 font-medium text-on-accent hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
          >
            Approve and send
          </button>
          <p className="mt-2 text-muted">The draft above is emailed to the customer only after you approve it.</p>
        </section>
      ) : null}

      {pending ? (
        <section className="mt-4 border-t border-line pt-4">
          <label htmlFor={ids.note} className="mb-1 block font-medium">
            Review note (optional)
          </label>
          <textarea
            id={ids.note}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={2}
            className="mb-3 w-full rounded border border-line bg-card p-2 focus-visible:outline-2 focus-visible:outline-accent"
          />

          <div className="flex flex-wrap gap-2">
            {editing ? (
              <>
                <button
                  type="button"
                  disabled={busy || reply.trim() === ''}
                  onClick={() => review.mutate({ action: 'edit', edited_reply: reply, ...cleanNote })}
                  className="rounded bg-accent px-3 py-1.5 font-medium text-on-accent hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
                >
                  Save edited reply
                </button>
                <button type="button" disabled={busy} onClick={() => setEditing(false)} className="rounded border border-line px-3 py-1.5 hover:bg-page disabled:opacity-60">
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy || !hasDraft}
                  aria-describedby={hasDraft ? undefined : ids.noDraft}
                  onClick={() => review.mutate({ action: 'approve', ...cleanNote })}
                  className="rounded bg-accent px-3 py-1.5 font-medium text-on-accent hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
                >
                  Approve draft
                </button>
                <button type="button" disabled={busy} onClick={() => setEditing(true)} className="rounded border border-line px-3 py-1.5 hover:bg-page disabled:opacity-60">
                  Edit
                </button>
              </>
            )}
            <button type="button" disabled={busy} onClick={() => review.mutate({ action: 'reject', ...cleanNote })} className="rounded border border-line px-3 py-1.5 text-bad-ink hover:bg-bad-bg disabled:opacity-60">
              Reject
            </button>
          </div>
          {!hasDraft && !editing ? (
            <p id={ids.noDraft} className="mt-2 text-muted">
              There is no draft to approve. Edit to write the reply yourself, or reject.
            </p>
          ) : null}
        </section>
      ) : ticket.status === 'triaged' ? null : (
        <Section title={`Decision: ${STATUS_LABEL[ticket.status]}`}>
          {ticket.final_reply ? <Plain text={ticket.final_reply} /> : <p className="text-muted">No reply was sent (rejected).</p>}
          {ticket.review_note ? (
            <p className="mt-2 break-words whitespace-pre-wrap">
              <span className="text-muted">Note: </span>
              {ticket.review_note}
            </p>
          ) : null}
          <p className="mt-2 text-muted">
            {ticket.reviewed_by ? `Reviewed by ${ticket.reviewed_by.name}` : 'Reviewer unknown'}
            {ticket.reviewed_at ? `, ${exactTime(ticket.reviewed_at)}` : ''}
          </p>
          {ticket.status === 'approved' || ticket.status === 'edited' ? <DeliveryStatus ticketId={ticket.ticket_id} /> : null}
        </Section>
      )}
    </article>
  );
}

/** How the email of an approved reply is going. A rejected ticket never shows this. */
function DeliveryStatus({ ticketId }: { ticketId: string }) {
  const queryClient = useQueryClient();
  const delivery = useDelivery(ticketId, true);
  const retry = useMutation<Delivery, ApiError>({
    mutationFn: () => retryDelivery(ticketId),
    onSuccess: (fresh) => queryClient.setQueryData(keys.delivery(ticketId), fresh),
    // 409: it was not failed any more (someone else retried it). Look again.
    onError: () => void queryClient.invalidateQueries({ queryKey: keys.delivery(ticketId) }),
  });
  const state = delivery.data;
  if (!state || state.status === 'none') return <div role="status" aria-live="polite" />;

  return (
    <div role="status" aria-live="polite" className="mt-3 rounded border border-line bg-page p-2">
      {state.status === 'queued' ? <p>Sending…</p> : null}
      {state.status === 'sent' ? <p>{state.sent_at ? `Reply sent ${exactTime(state.sent_at)}` : 'Reply sent'}</p> : null}
      {state.status === 'skipped_no_email' ? <p>No customer email, so no reply was sent.</p> : null}
      {state.status === 'failed' ? (
        <div>
          <p className="font-medium text-danger">Sending failed</p>
          {state.error ? <p className="break-words text-muted">{state.error}</p> : null}
          <button
            type="button"
            disabled={retry.isPending}
            onClick={() => retry.mutate()}
            className="mt-2 rounded border border-line bg-card px-3 py-1 hover:bg-page focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-60"
          >
            Retry sending
          </button>
        </div>
      ) : null}
    </div>
  );
}
