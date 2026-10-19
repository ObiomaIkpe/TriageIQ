from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from app.api.auth import require_review_key
from app.api.deps import get_graph
from app.db import get_session
from app.graph.review import ReviewNotAllowed, ReviewNotPending, resume_review
from app.models import ReviewDecision, TicketRecord, TicketStatus
from app.tickets.store import (
    get_ticket_by_reference,
    get_ticket_for_update,
    record_review,
)

router = APIRouter(prefix="/tickets", tags=["review"])

NOT_WAITING = "Ticket is not waiting for a review"


@router.post(
    "/{ticket_id}/review",
    response_model=TicketRecord,
    # Route-level dependencies are resolved before the parameters below, so the key is
    # checked first: a caller without it learns nothing, not even whether the graph is up.
    dependencies=[Depends(require_review_key)],
)
def review_ticket(
    ticket_id: UUID, decision: ReviewDecision, graph=Depends(get_graph)
) -> TicketRecord:
    # FastAPI has already validated the body into a ReviewDecision (422 otherwise).
    # Only that validated object is ever passed on: a raw invalid resume value would
    # strand the paused ticket (see "Human review pause" in NOTES.md).
    ticket_id = str(ticket_id)

    # One transaction. It commits when the block ends normally and rolls back on any
    # exception (HTTPException included), leaving the row as it was.
    with get_session() as session:
        # Locks the row: a second reviewer of the same ticket waits here until this
        # transaction ends, then sees the new status and gets a 409.
        ticket = get_ticket_for_update(session, ticket_id)
        if ticket is None:
            raise HTTPException(status_code=404, detail="Ticket not found")
        if ticket.status != TicketStatus.pending_review:
            raise HTTPException(status_code=409, detail=NOT_WAITING)

        try:
            final = resume_review(graph, ticket_id, decision)
        except ReviewNotPending:
            raise HTTPException(status_code=409, detail=NOT_WAITING)
        except ReviewNotAllowed as exc:
            raise HTTPException(status_code=422, detail=str(exc))

        updated = record_review(session, ticket_id, decision, final.get("final_reply"))
        if updated is None:
            raise HTTPException(status_code=409, detail=NOT_WAITING)
        return updated


# Lives here because it is a lookup for the same people who review. It has two path
# segments, so the single-segment /tickets/{ticket_id} route can never capture it.
@router.get("/reference/{reference}", response_model=TicketRecord)
def read_ticket_by_reference(reference: str) -> TicketRecord:
    record = get_ticket_by_reference(reference)
    if record is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return record
