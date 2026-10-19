from langgraph.types import Command

from app.models import ReviewDecision

# The node the graph pauses in (see app/graph/human_review.py).
REVIEW_NODE = "human_review"


class ReviewNotPending(Exception):
    """The ticket is not waiting for a review: unknown id, finished, or already reviewed."""


class ReviewNotAllowed(Exception):
    """The decision cannot be applied to this ticket, such as approving when there is no draft."""


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

    Returns the final state values. Raises, before anything is run:
    - ReviewNotPending, if the ticket is unknown or is not waiting for a review (which
      includes a second resume of a ticket that has already been reviewed);
    - ReviewNotAllowed, if the decision is "approve" but there is no draft to approve
      (a low-confidence ticket skips drafting). Edit and reject are allowed without one.
    """
    config = _config(ticket_id)
    if not is_paused(graph, ticket_id):
        raise ReviewNotPending(f"Ticket {ticket_id} is not waiting for a review")

    if decision.action == "approve" and not graph.get_state(config).values.get("draft_reply"):
        raise ReviewNotAllowed("Cannot approve a ticket that has no draft reply; edit or reject it instead")

    return graph.invoke(Command(resume=decision.model_dump()), config)
