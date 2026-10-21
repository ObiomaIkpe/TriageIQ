"""A ticket classified as "other" skips retrieval and drafting, whatever its confidence.

Claude and the KB search are faked; the graph runs for real on a MemorySaver.
"""
import pytest
from langgraph.checkpoint.memory import MemorySaver

from app.graph import classifier, critic, kb_grader, kb_retrieval, reply_draft
from app.graph.build import build_triage_graph
from app.graph.critic import CritiqueResult
from app.models import Category, ClassificationResult, KbMatch, TicketIn, Urgency
from tests.helpers import ai_message

LOCKOUT = KbMatch(topic="account lockout", content="Lockout clears after 1 hour.", distance=0.3)


class FakeChain:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def invoke(self, inputs):
        self.calls.append(inputs)
        return self.result


@pytest.fixture
def run(monkeypatch):
    def _run(category, confidence):
        f = type("Fakes", (), {})()
        f.draft = FakeChain(ai_message("A reply."))
        f.critic = FakeChain(CritiqueResult(needs_human_review=False, reason=""))
        f.kb_calls = []

        def search(query, top_k):
            f.kb_calls.append(query)
            return [LOCKOUT]

        monkeypatch.setattr(classifier, "_chain", FakeChain(ClassificationResult(
            category=category, urgency=Urgency.high, confidence=confidence, reasoning="r")))
        monkeypatch.setattr(reply_draft, "_chain", f.draft)
        monkeypatch.setattr(critic, "_chain", f.critic)
        monkeypatch.setattr(kb_retrieval, "search_similar", search)
        graph = build_triage_graph(MemorySaver())
        f.final = graph.invoke(
            {"ticket": TicketIn(subject="Hello", body="Something is off.")},
            config={"configurable": {"thread_id": "t"}},
        )
        return f

    return _run


def test_other_with_high_confidence_is_flagged_without_retrieval_or_drafting(run):
    f = run(Category.other, 0.95)

    assert f.final["needs_human_review"] is True
    assert f.final["review_reason"] == "Ticket could not be categorised."
    assert "__interrupt__" in f.final  # paused at human_review
    assert f.kb_calls == [] and f.draft.calls == [] and f.critic.calls == []
    for key in ("draft_reply", "kb_context", "kb_grade"):
        assert key not in f.final


def test_other_with_low_confidence_keeps_the_low_confidence_reason(run):
    f = run(Category.other, 0.3)

    assert f.final["review_reason"] == "Low classifier confidence."
    assert "__interrupt__" in f.final
    assert f.kb_calls == [] and f.draft.calls == []


def test_routing_target_for_other_is_unchanged(run):
    f = run(Category.other, 0.95)

    assert f.final["routing_target"] == "general-queue-urgent"  # urgency is high here


def test_any_other_category_with_high_confidence_takes_the_usual_path(run):
    f = run(Category.account, 0.95)

    assert len(f.kb_calls) == 1 and len(f.draft.calls) == 1 and len(f.critic.calls) == 1
    assert f.final["kb_grade"]["status"] == "ok"
    assert f.final["needs_human_review"] is False
    assert "__interrupt__" not in f.final


def test_any_other_category_with_low_confidence_is_still_low_confidence(run):
    f = run(Category.billing, 0.3)

    assert f.final["review_reason"] == "Low classifier confidence."
    assert f.kb_calls == []
