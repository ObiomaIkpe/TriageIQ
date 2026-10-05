from langgraph.graph import StateGraph, END

from app.models import GraphState
from app.graph.classifier import classify
from app.graph.router import route
from app.graph.kb_retrieval import retrieve_kb_context
from app.graph.reply_draft import draft_reply
from app.graph.critic import critique


def build_triage_graph():
    graph = StateGraph(GraphState)

    graph.add_node("classify", classify)
    graph.add_node("route", route)
    graph.add_node("retrieve_kb", retrieve_kb_context)
    graph.add_node("draft_reply_node", draft_reply)
    graph.add_node("critique", critique)

    graph.set_entry_point("classify")
    graph.add_edge("classify", "route")
    graph.add_edge("route", "retrieve_kb")
    graph.add_edge("retrieve_kb", "draft_reply_node")
    graph.add_edge("draft_reply_node", "critique")
    graph.add_edge("critique", END)

    return graph.compile()


triage_graph = build_triage_graph()