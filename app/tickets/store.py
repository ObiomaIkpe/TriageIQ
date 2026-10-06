from typing import Optional
from uuid import UUID

from sqlalchemy import select

from app.db import get_connection, get_session
from app.models import KbMatch, TicketIn, TicketRecord, TicketStatus, TriageResult
from app.tickets.orm import TicketRow


def init_ticket_schema() -> None:
    """Create the tickets table and its index. Safe to run on every startup."""
    with get_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tickets (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                status TEXT NOT NULL,
                subject TEXT NOT NULL,
                body TEXT NOT NULL,
                customer_id TEXT,
                category TEXT NOT NULL,
                urgency TEXT NOT NULL,
                confidence DOUBLE PRECISION NOT NULL,
                routing_target TEXT NOT NULL,
                suggested_reply TEXT,
                kb_sources JSONB NOT NULL DEFAULT '[]',
                needs_human_review BOOLEAN NOT NULL,
                review_reason TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            )
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS tickets_status_created_idx
            ON tickets (status, created_at)
        """)


def _to_row(ticket: TicketIn, result: TriageResult) -> TicketRow:
    status = (
        TicketStatus.pending_review
        if result.needs_human_review
        else TicketStatus.triaged
    )
    return TicketRow(
        id=UUID(result.ticket_id),
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
    )


def save_ticket(ticket: TicketIn, result: TriageResult) -> None:
    """Insert one row, using result.ticket_id as the primary key."""
    with get_session() as session:
        session.add(_to_row(ticket, result))


def get_ticket(ticket_id: str) -> Optional[TicketRecord]:
    with get_session() as session:
        row = session.get(TicketRow, UUID(ticket_id))
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
