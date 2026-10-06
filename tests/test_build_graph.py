from langgraph.checkpoint.memory import MemorySaver

from app.graph.build import build_triage_graph


def test_without_a_checkpointer_the_graph_has_none():
    assert build_triage_graph().checkpointer is None


def test_the_given_checkpointer_is_used():
    saver = MemorySaver()

    assert build_triage_graph(saver).checkpointer is saver


def test_the_nodes_and_edges_do_not_depend_on_the_checkpointer():
    plain = build_triage_graph()
    with_saver = build_triage_graph(MemorySaver())

    assert set(plain.get_graph().nodes) == set(with_saver.get_graph().nodes)
    assert {n for n in plain.get_graph().nodes} >= {
        "classify", "route", "retrieve_kb", "draft_reply_node",
        "critique", "flag_low_confidence",
    }
    assert sorted(
        (e.source, e.target) for e in plain.get_graph().edges
    ) == sorted((e.source, e.target) for e in with_saver.get_graph().edges)
