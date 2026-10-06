from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Query

from app.models import TicketRecord, TicketStatus
from app.tickets.store import get_ticket, list_tickets

router = APIRouter(prefix="/tickets", tags=["tickets"])


@router.get("", response_model=list[TicketRecord])
def read_tickets(
    status: Optional[TicketStatus] = None,
    limit: int = Query(50, ge=1, le=200),
) -> list[TicketRecord]:
    return list_tickets(status=status, limit=limit)


@router.get("/{ticket_id}", response_model=TicketRecord)
def read_ticket(ticket_id: UUID) -> TicketRecord:
    record = get_ticket(str(ticket_id))
    if record is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return record
