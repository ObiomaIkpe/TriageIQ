from fastapi import APIRouter

from app.models import TicketIn, TriageResult, GraphState
from app.graph.build import triage_graph

router = APIRouter(prefix="/triage", tags=["triage"])


@router.post("", response_model=TriageResult)
def triage_ticket(ticket: TicketIn) -> TriageResult:
    initial_state: GraphState = {"ticket": ticket}
    final_state = triage_graph.invoke(initial_state)

    # Strict lookups on purpose: every node must write its fields, and a
    # missing one should fail loudly (500) instead of silently defaulting.
    classification = final_state["classification"]

    return TriageResult(
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