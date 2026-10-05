from app.models import GraphState


def flag_low_confidence(state: GraphState) -> GraphState:
    return {
        "needs_human_review": True,
        "review_reason": "Low classifier confidence.",
    }
