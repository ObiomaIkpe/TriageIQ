from collections.abc import Iterator
from contextlib import contextmanager
from typing import Optional
from uuid import UUID

from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app import db
from app.db import get_session
from app.models import (
    KbMatch,
    ReviewDecision,
    ReviewedBy,
    Reviewer,
    TicketIn,
    TicketRecord,
    TicketStatus,
    TriageResult,
)
from app.tickets.orm import TicketRow
from app.tickets.reference import new_reference

# The unique constraint on tickets.reference (see migration 0002).
REFERENCE_CONSTRAINT = "tickets_reference_key"
# The primary key of tickets (the default name Postgres gives it).
TICKET_ID_CONSTRAINT = "tickets_pkey"
# How long a request waits for another request with the same ticket id before giving up
# with a retryable 503. Longer than the gateway's triage timeout (2 minutes), so by then
# the gateway has stopped waiting anyway.
TICKET_LOCK_TIMEOUT = "150s"
# After the first attempt fails on a reference collision, try this many more times.
MAX_REFERENCE_RETRIES = 3

_STATUS_FOR_ACTION = {
    "approve": TicketStatus.approved,
    "edit": TicketStatus.edited,
    "reject": TicketStatus.rejected,
}


def _to_row(ticket: TicketIn, result: TriageResult) -> TicketRow:
    status = (
        TicketStatus.pending_review
        if result.needs_human_review
        else TicketStatus.triaged
    )
    return TicketRow(
        id=UUID(result.ticket_id),
        reference=result.reference,
        status=status.value,
        subject=ticket.subject,
        body=ticket.body,
        customer_id=ticket.customer_id,
        category=result.category.value,
        urgency=result.urgency.value,
        confidence=result.confidence,
        routing_target=result.routing_target,
        suggested_reply=result.suggested_reply,
        kb_sources=[m.model_dump(mode="json") for m in result.kb_sources],
        needs_human_review=result.needs_human_review,
        review_reason=result.review_reason,
    )


def _to_record(row: TicketRow) -> TicketRecord:
    return TicketRecord(
        ticket_id=str(row.id),
        reference=row.reference,
        status=row.status,
        subject=row.subject,
        body=row.body,
        customer_id=row.customer_id,
        category=row.category,
        urgency=row.urgency,
        confidence=row.confidence,
        routing_target=row.routing_target,
        suggested_reply=row.suggested_reply,
        kb_sources=[KbMatch.model_validate(m) for m in row.kb_sources],
        needs_human_review=row.needs_human_review,
        review_reason=row.review_reason,
        created_at=row.created_at,
        final_reply=row.final_reply,
        review_note=row.review_note,
        reviewed_at=row.reviewed_at,
        reviewed_by=(
            ReviewedBy(id=row.reviewed_by_id, name=row.reviewed_by_name)
            if row.reviewed_by_id is not None and row.reviewed_by_name is not None
            else None
        ),
    )


def _is_reference_collision(exc: IntegrityError) -> bool:
    # Only the reference constraint is retried. Any other integrity error (such as a
    # duplicate id) is a real problem and must propagate.
    diag = getattr(exc.orig, "diag", None)
    return getattr(diag, "constraint_name", None) == REFERENCE_CONSTRAINT


def is_ticket_id_collision(exc: IntegrityError) -> bool:
    """True when an insert failed because a row with that ticket id already exists."""
    diag = getattr(exc.orig, "diag", None)
    return getattr(diag, "constraint_name", None) == TICKET_ID_CONSTRAINT


_LOCK_SQL = text("SELECT pg_advisory_lock(hashtextextended('triageiq:ticket:' || :id, 0))")
_UNLOCK_SQL = text("SELECT pg_advisory_unlock(hashtextextended('triageiq:ticket:' || :id, 0))")


@contextmanager
def ticket_lock(ticket_id: str) -> Iterator[None]:
    """Hold a Postgres advisory lock for one ticket id until the block ends.

    Two requests with the same ticket id never run their block at the same time: the
    second one waits here (up to TICKET_LOCK_TIMEOUT, then a retryable database error).
    It is a session-level lock on its own connection, so it can span the whole graph
    run without keeping a transaction open, and Postgres releases it by itself if the
    connection dies. The key is a hash of the id, in a namespace of its own.
    """
    with db.SessionLocal() as session:
        conn = session.connection(execution_options={"isolation_level": "AUTOCOMMIT"})
        try:
            conn.execute(text(f"SET lock_timeout = '{TICKET_LOCK_TIMEOUT}'"))
            conn.execute(_LOCK_SQL, {"id": ticket_id})
        except BaseException:
            # Not locked (timeout or a broken connection). Do not return a connection with
            # a changed setting to the pool.
            conn.invalidate()
            raise
        try:
            yield
        finally:
            try:
                conn.execute(_UNLOCK_SQL, {"id": ticket_id})
                conn.execute(text("RESET lock_timeout"))
            except BaseException:
                # The lock could not be released cleanly: drop the connection instead of
                # returning it to the pool, which ends the session and so the lock.
                conn.invalidate()
                raise


def save_ticket(ticket: TicketIn, result: TriageResult) -> str:
    """Insert one row, using result.ticket_id as the primary key.

    Returns the reference that was stored. If result.reference collides with an
    existing one, a new reference is generated and the insert retried (at most
    MAX_REFERENCE_RETRIES times), so the returned value can differ from the one passed in.
    """
    for attempt in range(MAX_REFERENCE_RETRIES + 1):
        try:
            with get_session() as session:
                session.add(_to_row(ticket, result))
            return result.reference
        except IntegrityError as exc:
            if not _is_reference_collision(exc) or attempt == MAX_REFERENCE_RETRIES:
                raise
            result = result.model_copy(update={"reference": new_reference()})
    raise AssertionError("unreachable")  # the loop returns or raises


def get_ticket(ticket_id: str) -> Optional[TicketRecord]:
    with get_session() as session:
        row = session.get(TicketRow, UUID(ticket_id))
        return _to_record(row) if row is not None else None


def get_ticket_by_reference(reference: str) -> Optional[TicketRecord]:
    with get_session() as session:
        row = session.scalars(
            select(TicketRow).where(TicketRow.reference == reference)
        ).one_or_none()
        return _to_record(row) if row is not None else None


def get_ticket_for_update(session: Session, ticket_id: str) -> Optional[TicketRecord]:
    """Read one ticket and lock its row until the session's transaction ends.

    A second transaction asking for the same row waits here, then sees whatever the
    first one committed. The caller owns the transaction.
    """
    row = session.scalars(
        select(TicketRow).where(TicketRow.id == UUID(ticket_id)).with_for_update()
    ).one_or_none()
    return _to_record(row) if row is not None else None


def record_review(
    session: Session,
    ticket_id: str,
    decision: ReviewDecision,
    final_reply: Optional[str],
    reviewer: Reviewer,
) -> Optional[TicketRecord]:
    """Store a reviewer's decision on a ticket that is still pending_review.

    One UPDATE with `status = 'pending_review'` in its WHERE clause, so of two
    reviewers deciding at the same moment only one matches a row. Returns the updated
    record, or None if no row matched (unknown id, or the ticket is not pending). The
    caller owns the transaction.

    The reviewer's id and name are written by the SAME statement as the decision, so a review
    can never be saved without its author. The name is a snapshot: renaming the reviewer later
    does not change old reviews. A second review matches no row, so it cannot overwrite them.
    """
    statement = (
        update(TicketRow)
        .where(
            TicketRow.id == UUID(ticket_id),
            TicketRow.status == TicketStatus.pending_review.value,
        )
        .values(
            status=_STATUS_FOR_ACTION[decision.action].value,
            final_reply=final_reply,
            review_note=decision.note,
            reviewed_at=func.now(),
            reviewed_by_id=reviewer.id,
            reviewed_by_name=reviewer.name,
            updated_at=func.now(),
        )
        .returning(TicketRow)
        .execution_options(populate_existing=True)
    )
    row = session.scalars(statement).one_or_none()
    return _to_record(row) if row is not None else None


def list_tickets(
    status: Optional[TicketStatus] = None, limit: int = 50
) -> list[TicketRecord]:
    """Newest first. The status filter is only added when a status is given."""
    query = select(TicketRow).order_by(TicketRow.created_at.desc()).limit(limit)
    if status is not None:
        query = query.where(TicketRow.status == status.value)

    with get_session() as session:
        return [_to_record(row) for row in session.scalars(query)]
