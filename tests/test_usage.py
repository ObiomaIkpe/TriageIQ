"""Token usage per ticket and the estimated cost: the maths, the callback, the voyage hook, the report."""
import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage

from app import config, usage
from app.api import triage as triage_api
from app.tools import cost_report


def _message(tokens_in, tokens_out, model="claude-sonnet-4-6"):
    return AIMessage(
        content="x",
        usage_metadata={"input_tokens": tokens_in, "output_tokens": tokens_out, "total_tokens": tokens_in + tokens_out},
        response_metadata={"model_name": model},
    )


def test_cost_maths_uses_the_published_prices():
    # 1,000 in at $3/M + 500 out at $15/M = 0.003 + 0.0075
    assert usage.cost_usd("claude-sonnet-4-6", 1000, 500) == pytest.approx(0.0105)
    assert usage.cost_usd("voyage-3", 1_000_000, 0) == pytest.approx(0.06)


def test_an_unknown_model_has_no_price():
    assert usage.cost_usd("some-future-model", 10, 10) is None


def test_prices_are_in_config_and_carry_a_date():
    assert set(config.PRICES_USD_PER_MTOK) >= {"claude-sonnet-4-6", "voyage-3"}
    assert config.PRICES_AS_OF[:2] == "20"


def test_the_summary_adds_calls_tokens_and_cost_per_provider():
    with usage.collect() as collector:
        collector.add("anthropic", "claude-sonnet-4-6", 1000, 500)
        collector.add("anthropic", "claude-sonnet-4-6", 2000, 100)
        usage.record_embedding("voyage-3", 400)
    summary = collector.summary()

    assert summary["estimate"] is True
    assert summary["providers"]["anthropic"] == {"calls": 2, "total_tokens": 3600}
    assert summary["providers"]["voyage"] == {"calls": 1, "total_tokens": 400}
    assert summary["total_tokens"] == 4000
    expected = (3000 * 3 + 600 * 15) / 1e6 + 400 * 0.06 / 1e6
    assert summary["estimated_cost_usd"] == pytest.approx(expected, abs=1e-6)


def test_one_unpriced_model_makes_the_total_unknown_not_too_low():
    with usage.collect() as collector:
        collector.add("anthropic", "claude-sonnet-4-6", 10, 10)
        collector.add("anthropic", "mystery-model", 10, 10)
    summary = collector.summary()
    assert summary["estimated_cost_usd"] is None
    assert summary["total_tokens"] == 40  # tokens are still counted


def test_a_call_outside_any_collector_is_ignored():
    usage.record_embedding("voyage-3", 5)  # no collector: nothing happens, nothing raises
    assert usage.current() is None


def test_non_numbers_from_the_embedding_client_are_ignored():
    with usage.collect() as collector:
        usage.record_embedding("voyage-3", None)
        usage.record_embedding("voyage-3", "12")
        usage.record_embedding("voyage-3", True)
    assert collector.is_empty()


def test_the_callback_counts_a_finished_claude_call():
    model = GenericFakeChatModel(messages=iter([_message(120, 30)]), callbacks=[usage.usage_callback])
    with usage.collect() as collector:
        model.invoke("hello")
    (entry,) = collector.summary()["by_model"]
    assert (entry["provider"], entry["model"], entry["input_tokens"], entry["output_tokens"]) == ("anthropic", "claude-sonnet-4-6", 120, 30)


def test_the_collector_reaches_calls_made_inside_a_langgraph_node():
    from langgraph.graph import END, START, StateGraph
    from typing import TypedDict

    class State(TypedDict, total=False):
        done: bool

    model = GenericFakeChatModel(messages=iter([_message(50, 5)]), callbacks=[usage.usage_callback])

    def node(state):
        model.invoke("x")
        return {"done": True}

    graph = StateGraph(State)
    graph.add_node("n", node)
    graph.add_edge(START, "n")
    graph.add_edge("n", END)
    with usage.collect() as collector:
        graph.compile().invoke({})
    assert collector.summary()["providers"]["anthropic"]["total_tokens"] == 55


def test_every_claude_client_in_the_graph_carries_the_callback():
    from app.graph import classifier, critic, kb_grader, reply_draft

    for module in (classifier, critic, kb_grader, reply_draft):
        assert usage.usage_callback in module._llm.callbacks, module.__name__


def test_the_voyage_call_reports_its_tokens(monkeypatch):
    from app.kb import store

    class Result:
        embeddings = [[0.0]]
        total_tokens = 37

    monkeypatch.setattr(store._voyage, "embed", lambda *a, **k: Result())
    monkeypatch.setattr(store._limiter, "acquire", lambda: None)
    with usage.collect() as collector:
        store._embed_with_retry("some text", "query")
    assert collector.summary()["providers"]["voyage"]["total_tokens"] == 37


def test_storing_the_usage_never_fails_the_request(monkeypatch):
    def boom(ticket_id, summary):
        raise RuntimeError("database down")

    monkeypatch.setattr(triage_api, "attach_usage", boom)
    with usage.collect() as collector:
        collector.add("anthropic", "claude-sonnet-4-6", 1, 1)
        triage_api._record_usage("00000000-0000-0000-0000-000000000000", collector)  # must not raise


def test_nothing_is_stored_when_no_model_was_called(monkeypatch):
    calls = []
    monkeypatch.setattr(triage_api, "attach_usage", lambda *a: calls.append(a))
    with usage.collect() as collector:
        triage_api._record_usage("00000000-0000-0000-0000-000000000000", collector)
    assert calls == []


def test_cost_report_statistics():
    rows = [(0.01, {"total_tokens": 1000}), (0.03, {"total_tokens": 3000}), (0.02, {"total_tokens": 2000}), (None, None)]
    summary = cost_report.summarize(rows)
    assert summary["tickets_with_cost"] == 3 and summary["tickets_without_cost"] == 1
    assert summary["average_usd"] == pytest.approx(0.02)
    assert summary["median_usd"] == pytest.approx(0.02)
    assert summary["max_usd"] == pytest.approx(0.03)
    assert summary["total_tokens"] == 6000
    assert "ESTIMATE" in cost_report.format_report(summary, 4)


def test_cost_report_with_no_costs_does_not_divide_by_zero():
    summary = cost_report.summarize([(None, None)])
    assert summary["average_usd"] is None
    assert "n/a" in cost_report.format_report(summary, 1)
