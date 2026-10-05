from fastapi import APIRouter

from app.models import TicketIn, TriageResult, GraphState
from app.graph.build import triage_graph

router = APIRouter(prefix="/triage", tags=["triage"])


@router.post("", response_model=TriageResult)
def triage_ticket(ticket: TicketIn) -> TriageResult:
    initial_state: GraphState = {"ticket": ticket}
    final_state = triage_graph.invoke(initial_state)

    classification = final_state["classification"]

    return TriageResult(
        category=classification.category,
        urgency=classification.urgency,
        confidence=classification.confidence,
        routing_target=final_state.get("routing_target", "general-queue"),
        suggested_reply=final_state.get("draft_reply"),
        kb_sources=final_state.get("kb_context", []),
        needs_human_review=final_state.get("needs_human_review", True),
        review_reason=final_state.get("review_reason") or None,
    )