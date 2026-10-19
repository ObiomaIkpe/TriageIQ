from langgraph.types import Command

from app.models import ReviewDecision

# The node the graph pauses in (see app/graph/human_review.py).
REVIEW_NODE = "human_review"


class ReviewNotPending(Exception):
    """The ticket is not waiting for a review: unknown id, finished, or already reviewed."""


def _config(ticket_id: str) -> dict:
    # The ticket id is the LangGraph thread id (set in app/api/triage.py).
    return {"configurable": {"thread_id": ticket_id}}


def is_paused(graph, ticket_id: str) -> bool:
    """True if the ticket's run is paused at the human_review step.

    An unknown ticket id has no saved state, so it is simply not paused.
    """
    return REVIEW_NODE in graph.get_state(_config(ticket_id)).next


def resume_review(graph, ticket_id: str, decision: ReviewDecision) -> dict:
    """Give a paused ticket its reviewer's decision and let the run finish.

    Returns the final state values. Raises ReviewNotPending, before anything is
    run, if the ticket is unknown or is not waiting for a review (which includes a
    second resume of a ticket that has already been reviewed).
    """
    if not is_paused(graph, ticket_id):
        raise ReviewNotPending(f"Ticket {ticket_id} is not waiting for a review")

    return graph.invoke(Command(resume=decision.model_dump()), _config(ticket_id))
