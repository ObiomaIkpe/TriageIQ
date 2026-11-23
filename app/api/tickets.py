from datetime import datetime
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query

from app.models import TicketRecord, TicketStatus
from app.tickets.store import count_tickets_by_status, get_ticket, list_tickets

router = APIRouter(prefix="/tickets", tags=["tickets"])


def _parse_cursor(cursor: str) -> tuple[datetime, UUID]:
    """"<created_at ISO>|<ticket id>", exactly what the last ticket of the previous page shows."""
    try:
        created_at, ticket_id = cursor.split("|", 1)
        return datetime.fromisoformat(created_at), UUID(ticket_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="Invalid cursor")


@router.get("", response_model=list[TicketRecord])
def read_tickets(
    status: Optional[TicketStatus] = None,
    limit: int = Query(50, ge=1, le=200),
    cursor: Optional[str] = Query(None, max_length=100),
    reviewed_since: Optional[datetime] = None,
) -> list[TicketRecord]:
    extra = {}
    if cursor is not None:
        extra["before"] = _parse_cursor(cursor)
    if reviewed_since is not None:
        extra["reviewed_since"] = reviewed_since
    return list_tickets(status=status, limit=limit, **extra)


# Declared BEFORE /{ticket_id}: otherwise "counts" would be read as a ticket id (and be a 422).
@router.get("/counts", response_model=dict[str, int])
def read_ticket_counts() -> dict[str, int]:
    return count_tickets_by_status()


@router.get("/{ticket_id}", response_model=TicketRecord)
def read_ticket(ticket_id: UUID) -> TicketRecord:
    record = get_ticket(str(ticket_id))
    if record is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return record
