from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from app.api.auth import get_scope, require_review_key
from app.api.deps import get_graph
from app.db import get_session
from app.demo.review import final_reply_without_graph
from app.graph.review import ReviewNotAllowed, ReviewNotPending, is_paused, resume_review
from app.models import ReviewDecision, ReviewRequest, TicketRecord, TicketStatus
from app.tickets.store import (
    get_ticket_by_reference,
    get_ticket_for_update,
    record_review,
)

router = APIRouter(prefix="/tickets", tags=["review"])

NOT_WAITING = "Ticket is not waiting for a review"
TRIAGED_APPROVE_ONLY = "An auto-handled ticket can only be approved"
TRIAGED_NO_DRAFT = "Cannot approve an auto-handled ticket that has no draft reply"


@router.post(
    "/{ticket_id}/review",
    response_model=TicketRecord,
    # Route-level dependencies are resolved before the parameters below, so the key is
    # checked first: a caller without it learns nothing, not even whether the graph is up.
    dependencies=[Depends(require_review_key)],
)
def review_ticket(
    ticket_id: UUID, request: ReviewRequest, graph=Depends(get_graph), scope=Depends(get_scope)
) -> TicketRecord:
    # FastAPI has already validated the body into a ReviewRequest (422 otherwise: a missing or
    # malformed `reviewer` is refused like any other bad field).
    #
    # WHY THE REVIEWER IS TRUSTED: this endpoint is only reachable with the service review key
    # (the route dependency above), and only the gateway holds that key. The gateway fills in
    # `reviewer` from the caller it authenticated (a logged-in user's session, or an API client)
    # and never takes it from the client's own body. So `reviewer` says who the gateway
    # authenticated, not what a caller claims. Anyone who has the key can name any reviewer, which is
    # why the key must stay on the server.
    #
    # Only the decision part is passed to the graph: a raw invalid resume value would strand the
    # paused ticket (see "Human review pause" in NOTES.md), and the graph does not know reviewers.
    decision = ReviewDecision(
        action=request.action, edited_reply=request.edited_reply, note=request.note
    )
    ticket_id = str(ticket_id)

    # One transaction. It commits when the block ends normally and rolls back on any
    # exception (HTTPException included), leaving the row as it was.
    with get_session() as session:
        # Locks the row: a second reviewer of the same ticket waits here until this
        # transaction ends, then sees the new status and gets a 409.
        # The scope comes from the gateway (a demo visitor reviews only demo tickets, a real reviewer only real ones). A ticket on
        # the other side of the wall is not found, exactly like an unknown id: its existence is not revealed.
        ticket = get_ticket_for_update(session, ticket_id, scope)
        if ticket is None:
            raise HTTPException(status_code=404, detail="Ticket not found")
        if ticket.status == TicketStatus.triaged:
            # One-click approval of an AUTO-HANDLED ticket: the AI finished it without a reviewer and its graph run is over,
            # so there is nothing to resume. Only "approve", and only when there is a draft, is accepted: its draft becomes
            # the final reply. (Edit and reject would also be safe to apply without a graph, but this step is about sending
            # the AI's own reply after a person has seen it; anything else stays out until it is needed.)
            if decision.action != "approve":
                raise HTTPException(status_code=409, detail=TRIAGED_APPROVE_ONLY)
            if not (ticket.suggested_reply or "").strip():
                raise HTTPException(status_code=409, detail=TRIAGED_NO_DRAFT)
            updated = record_review(
                session, ticket_id, decision, ticket.suggested_reply, request.reviewer,
                from_status=TicketStatus.triaged,
            )
            if updated is None:
                raise HTTPException(status_code=409, detail=NOT_WAITING)
            return updated
        if ticket.status != TicketStatus.pending_review:
            raise HTTPException(status_code=409, detail=NOT_WAITING)

        if ticket.is_demo and not is_paused(graph, ticket_id):
            # A SEEDED demo example (python -m app.demo.seed): its flagged state was written straight into the row, so no
            # graph run (and no checkpoint) exists to resume. The same three outcomes the graph's human_review node gives are
            # applied here directly: approve -> the draft, edit -> the edited text, reject -> none. A demo ticket a visitor
            # SUBMITTED did run the graph and is paused in it: it goes the normal way below. Real tickets never take this branch.
            try:
                final_reply = final_reply_without_graph(ticket, decision)
            except ReviewNotAllowed as exc:
                raise HTTPException(status_code=422, detail=str(exc))
        else:
            try:
                final = resume_review(graph, ticket_id, decision)
            except ReviewNotPending:
                raise HTTPException(status_code=409, detail=NOT_WAITING)
            except ReviewNotAllowed as exc:
                raise HTTPException(status_code=422, detail=str(exc))
            final_reply = final.get("final_reply")

        updated = record_review(
            session, ticket_id, decision, final_reply, request.reviewer
        )
        if updated is None:
            raise HTTPException(status_code=409, detail=NOT_WAITING)
        return updated


# Lives here because it is a lookup for the same people who review. It has two path
# segments, so the single-segment /tickets/{ticket_id} route can never capture it.
@router.get("/reference/{reference}", response_model=TicketRecord)
def read_ticket_by_reference(reference: str, scope=Depends(get_scope)) -> TicketRecord:
    record = get_ticket_by_reference(reference, scope)
    if record is None:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return record
