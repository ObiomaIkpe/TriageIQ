from langgraph.types import interrupt
from pydantic import ValidationError

from app.models import GraphState, ReviewDecision


# IMPORTANT: when the graph resumes, LangGraph runs this whole node again from its first
# line (that is how interrupt() works). Everything before the interrupt() call therefore
# runs twice, so nothing with a side effect (an LLM call, a database write, a message)
# may be added above it. Today the only code before it is the guard and the payload.
def human_review(state: GraphState) -> GraphState:
    if not state.get("needs_human_review"):
        return {}

    classification = state["classification"]
    decision = interrupt({
        "review_reason": state.get("review_reason"),
        "suggested_reply": state.get("draft_reply"),
        "category": classification.category.value,
        "urgency": classification.urgency.value,
        "routing_target": state.get("routing_target"),
    })

    try:
        validated = ReviewDecision.model_validate(decision)
    except ValidationError as exc:
        raise ValueError(f"Invalid review decision: {exc}") from exc

    if validated.action == "approve":
        final_reply = state.get("draft_reply")
    elif validated.action == "edit":
        final_reply = validated.edited_reply
    else:  # reject
        final_reply = None

    return {"review_decision": validated.model_dump(), "final_reply": final_reply}
