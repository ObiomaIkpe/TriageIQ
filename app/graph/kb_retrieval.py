import logging

from app.models import GraphState
from app.kb.store import search_similar

logger = logging.getLogger(__name__)


def retrieve_kb_context(state: GraphState) -> GraphState:
    ticket = state["ticket"]
    query_text = f"{ticket.subject} {ticket.body}"

    try:
        matches = search_similar(query_text, top_k=3)
    except Exception:
        logger.exception("Knowledge base lookup failed; continuing without context")
        return {**state, "kb_context": [], "kb_failed": True}
    return {**state, "kb_context": matches, "kb_failed":False}