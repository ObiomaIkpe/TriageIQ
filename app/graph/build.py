from langgraph.graph import StateGraph, END

from app.config import settings
from app.models import GraphState
from app.graph.classifier import classify
from app.graph.router import route
from app.graph.kb_retrieval import retrieve_kb_context
from app.graph.reply_draft import draft_reply
from app.graph.critic import critique
from app.graph.flag_low_confidence import flag_low_confidence


def route_by_confidence(state: GraphState) -> str:
    """Name of the node to run after `route`.

    Exactly the threshold counts as confident (>=), so only values strictly
    below it are treated as low confidence.
    """
    if state["classification"].confidence >= settings.low_confidence_threshold:
        return "retrieve_kb"
    return "flag_low_confidence"


def build_triage_graph():
    graph = StateGraph(GraphState)

    graph.add_node("classify", classify)
    graph.add_node("route", route)
    graph.add_node("retrieve_kb", retrieve_kb_context)
    graph.add_node("draft_reply_node", draft_reply)
    graph.add_node("critique", critique)
    graph.add_node("flag_low_confidence", flag_low_confidence)

    graph.set_entry_point("classify")
    graph.add_edge("classify", "route")
    graph.add_conditional_edges(
        "route",
        route_by_confidence,
        {
            "retrieve_kb": "retrieve_kb",
            "flag_low_confidence": "flag_low_confidence",
        },
    )
    graph.add_edge("retrieve_kb", "draft_reply_node")
    graph.add_edge("draft_reply_node", "critique")
    graph.add_edge("critique", END)
    graph.add_edge("flag_low_confidence", END)

    return graph.compile()


triage_graph = build_triage_graph()