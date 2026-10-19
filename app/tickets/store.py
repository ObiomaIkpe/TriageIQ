from typing import Optional
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_session
from app.models import (
    KbMatch,
    ReviewDecision,
    TicketIn,
    TicketRecord,
    TicketStatus,
    TriageResult,
)
from app.tickets.orm import TicketRow
from app.tickets.reference import new_reference

# The unique constraint on tickets.reference (see migration 0002).
REFERENCE_CONSTRAINT = "tickets_reference_key"
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
    )


def _is_reference_collision(exc: IntegrityError) -> bool:
    # Only the reference constraint is retried. Any other integrity error (such as a
    # duplicate id) is a real problem and must propagate.
    diag = getattr(exc.orig, "diag", None)
    return getattr(diag, "constraint_name", None) == REFERENCE_CONSTRAINT


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


def record_review(
    session: Session,
    ticket_id: str,
    decision: ReviewDecision,
    final_reply: Optional[str],
) -> Optional[TicketRecord]:
    """Store a reviewer's decision on a ticket that is still pending_review.

    One UPDATE with `status = 'pending_review'` in its WHERE clause, so of two
    reviewers deciding at the same moment only one matches a row. Returns the updated
    record, or None if no row matched (unknown id, or the ticket is not pending). The
    caller owns the transaction.
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
