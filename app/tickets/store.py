from typing import Optional

from psycopg.types.json import Jsonb

from app.db import get_connection
from app.models import KbMatch, TicketIn, TicketRecord, TicketStatus, TriageResult

_COLUMNS = """
    id, status, subject, body, customer_id,
    category, urgency, confidence, routing_target,
    suggested_reply, kb_sources, needs_human_review, review_reason, created_at
"""


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


def save_ticket(ticket: TicketIn, result: TriageResult) -> None:
    """Insert one row, using result.ticket_id as the primary key."""
    status = (
        TicketStatus.pending_review
        if result.needs_human_review
        else TicketStatus.triaged
    )
    kb_sources = Jsonb([m.model_dump(mode="json") for m in result.kb_sources])

    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO tickets (
                id, status, subject, body, customer_id,
                category, urgency, confidence, routing_target,
                suggested_reply, kb_sources, needs_human_review, review_reason
            ) VALUES (
                %s::uuid, %s, %s, %s, %s,
                %s, %s, %s, %s,
                %s, %s, %s, %s
            )
            """,
            (
                result.ticket_id,
                status.value,
                ticket.subject,
                ticket.body,
                ticket.customer_id,
                result.category.value,
                result.urgency.value,
                result.confidence,
                result.routing_target,
                result.suggested_reply,
                kb_sources,
                result.needs_human_review,
                result.review_reason,
            ),
        )


def _to_record(row) -> TicketRecord:
    (
        ticket_id, status, subject, body, customer_id,
        category, urgency, confidence, routing_target,
        suggested_reply, kb_sources, needs_human_review, review_reason,
        created_at,
    ) = row
    return TicketRecord(
        ticket_id=str(ticket_id),
        status=status,
        subject=subject,
        body=body,
        customer_id=customer_id,
        category=category,
        urgency=urgency,
        confidence=confidence,
        routing_target=routing_target,
        suggested_reply=suggested_reply,
        kb_sources=[KbMatch.model_validate(m) for m in kb_sources],
        needs_human_review=needs_human_review,
        review_reason=review_reason,
        created_at=created_at,
    )


def get_ticket(ticket_id: str) -> Optional[TicketRecord]:
    with get_connection() as conn:
        row = conn.execute(
            "SELECT" + _COLUMNS + "FROM tickets WHERE id = %s::uuid",
            (ticket_id,),
        ).fetchone()
    return _to_record(row) if row is not None else None


def list_tickets(
    status: Optional[TicketStatus] = None, limit: int = 50
) -> list[TicketRecord]:
    """Newest first. The status filter is only added when a status is given."""
    sql = "SELECT" + _COLUMNS + "FROM tickets"
    params: list = []
    if status is not None:
        sql += " WHERE status = %s"
        params.append(status.value)
    sql += " ORDER BY created_at DESC LIMIT %s"
    params.append(limit)

    with get_connection() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [_to_record(row) for row in rows]
