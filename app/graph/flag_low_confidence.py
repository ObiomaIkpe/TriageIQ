from app.config import settings
from app.models import GraphState

LOW_CONFIDENCE_REASON = "Low classifier confidence."
UNCATEGORISED_REASON = "Ticket could not be categorised."


def flag_low_confidence(state: GraphState) -> GraphState:
    """Flag a ticket that skipped retrieval and drafting, with the reason it did.

    The graph sends a ticket here when its confidence is below the threshold or its
    category is "other". Low confidence wins when both apply.
    """
    if state["classification"].confidence < settings.low_confidence_threshold:
        reason = LOW_CONFIDENCE_REASON
    else:
        reason = UNCATEGORISED_REASON
    return {
        "needs_human_review": True,
        "review_reason": reason,
    }
