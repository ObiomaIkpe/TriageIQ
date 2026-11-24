"""Reviewing a SEEDED demo ticket, which has no LangGraph run to resume."""
from typing import Optional

from app.graph.review import ReviewNotAllowed
from app.models import ReviewDecision, TicketRecord


def final_reply_without_graph(ticket: TicketRecord, decision: ReviewDecision) -> Optional[str]:
    """The final reply a decision gives, worked out from the ticket row alone.

    It mirrors, case for case, what the graph's human_review node returns after a resume (app/graph/human_review.py) and the
    check resume_review makes before it (app/graph/review.py): approve takes the draft and is refused when there is no draft;
    edit takes the reviewer's text (the ReviewDecision model has already refused a blank one); reject gives no reply.
    """
    if decision.action == "approve":
        if not (ticket.suggested_reply or "").strip():
            raise ReviewNotAllowed("Cannot approve a ticket that has no draft reply; edit or reject it instead")
        return ticket.suggested_reply
    if decision.action == "edit":
        return decision.edited_reply
    return None
