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


def test_the_graph_starts_at_classify_and_nowhere_else():
    edges = [(e.source, e.target) for e in build_triage_graph().get_graph().edges]

    assert [e for e in edges if e[0] == "__start__"] == [("__start__", "classify")]


def test_the_pipeline_order_ends_at_human_review():
    edges = {(e.source, e.target) for e in build_triage_graph().get_graph().edges}

    assert {
        ("classify", "route"),
        ("route", "retrieve_kb"),
        ("route", "flag_low_confidence"),
        ("retrieve_kb", "draft_reply_node"),
        ("draft_reply_node", "critique"),
        ("critique", "human_review"),
        ("flag_low_confidence", "human_review"),
        ("human_review", "__end__"),
    } <= edges


def test_nothing_reaches_the_end_without_going_through_human_review():
    edges = {(e.source, e.target) for e in build_triage_graph().get_graph().edges}

    assert {source for source, target in edges if target == "__end__"} == {"human_review"}
