from app.models import GraphState
from app.kb.store import search_similar


def retrieve_kb_context(state: GraphState) -> GraphState:
    ticket = state["ticket"]
    query_text = f"{ticket.subject} {ticket.body}"

    matches = search_similar(query_text, top_k=3)

    return {**state, "kb_context": matches}