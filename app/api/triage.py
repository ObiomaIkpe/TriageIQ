from uuid import uuid4

from fastapi import APIRouter, Depends

from app.api.deps import get_graph
from app.models import TicketIn, TriageResult, GraphState
from app.tickets.reference import new_reference
from app.tickets.store import save_ticket

router = APIRouter(prefix="/triage", tags=["triage"])


@router.post("", response_model=TriageResult)
def triage_ticket(ticket: TicketIn, graph=Depends(get_graph)) -> TriageResult:
    # The id exists before the graph runs, and is the run's thread id, so a
    # paused or resumed run can be found again by ticket id.
    ticket_id = str(uuid4())
    reference = new_reference()
    initial_state: GraphState = {"ticket": ticket}
    final_state = graph.invoke(
        initial_state, config={"configurable": {"thread_id": ticket_id}}
    )

    # A ticket flagged for human review makes the run PAUSE at the human_review step;
    # invoke() then returns the state so far plus an "__interrupt__" entry. The response
    # below is built only from the named keys, so that entry never reaches the client,
    # and a paused run counts as a success (the ticket is saved as pending_review).

    # Strict lookups on purpose: every node must write its fields, and a
    # missing one should fail loudly (500) instead of silently defaulting.
    classification = final_state["classification"]

    result = TriageResult(
        ticket_id=ticket_id,
        reference=reference,
        category=classification.category,
        urgency=classification.urgency,
        confidence=classification.confidence,
        routing_target=final_state["routing_target"],
        # Optional on purpose: low-confidence tickets skip retrieval and
        # drafting, so these two keys are legitimately absent for them.
        suggested_reply=final_state.get("draft_reply"),
        kb_sources=final_state.get("kb_context", []),
        needs_human_review=final_state["needs_human_review"],
        review_reason=final_state["review_reason"] or None,
    )

    # Saved only after a successful graph run, so a failed run leaves no row.
    # If the save itself fails the error propagates (503 for a database outage).
    # save_ticket returns the reference it stored: after a collision it is a new one,
    # and the response must match the row.
    stored_reference = save_ticket(ticket, result)
    return result.model_copy(update={"reference": stored_reference})