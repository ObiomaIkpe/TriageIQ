"""A paused run that went through the KB grader resumes on a real PostgresSaver.

kb_grade is a plain dict in the state, so it needs no checkpoint allowlist entry; these
tests check that it comes back as a dict after a "restart" (new pool, saver and graph)
and that the grader is not called again on resume. Claude and the KB search are faked.
"""
import uuid

import pytest

from app.graph import classifier, critic, kb_grader, kb_retrieval, reply_draft
from app.graph.build import build_triage_graph
from app.graph.checkpointer import create_checkpointer
from app.graph.critic import CritiqueResult
from app.graph.kb_grader import KbGradeResult
from app.graph.review import is_paused, resume_review
from app.models import Category, ClassificationResult, KbMatch, ReviewDecision, TicketIn, Urgency
from tests.helpers import ai_message

pytestmark = pytest.mark.integration

LOCKOUT = KbMatch(topic="account lockout", content="Lockout clears after 1 hour.", distance=0.3)
RESET = KbMatch(topic="password reset", content="Use the Forgot password link.", distance=0.6)


class FakeChain:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def invoke(self, inputs):
        self.calls.append(inputs)
        return self.result


@pytest.fixture
def fakes(monkeypatch):
    f = type("Fakes", (), {})()
    f.grader = FakeChain(KbGradeResult(relevant_topics=[], reason="Neither answers it."))
    f.critic = FakeChain(CritiqueResult(needs_human_review=False, reason=""))
    monkeypatch.setattr(classifier, "_chain", FakeChain(ClassificationResult(
        category=Category.account, urgency=Urgency.high, confidence=0.95, reasoning="r")))
    monkeypatch.setattr(reply_draft, "_chain", FakeChain(ai_message("We will follow up.")))
    monkeypatch.setattr(critic, "_chain", f.critic)
    monkeypatch.setattr(kb_grader, "_chain", f.grader)
    monkeypatch.setattr(kb_retrieval, "search_similar", lambda q, top_k: [LOCKOUT, RESET])
    return f


@pytest.fixture
def start(clean_database):
    made = []

    def _start():
        checkpointer = create_checkpointer(clean_database)
        made.append(checkpointer)
        return build_triage_graph(checkpointer.saver), checkpointer

    yield _start
    for checkpointer in made:
        checkpointer.close()


def config(ticket_id):
    return {"configurable": {"thread_id": ticket_id}}


def run(graph, ticket_id):
    return graph.invoke(
        {"ticket": TicketIn(subject="Cannot log in", body="Account locked.")}, config(ticket_id)
    )


def test_a_rejected_grade_survives_a_restart_and_the_review_resumes(fakes, start):
    ticket_id = str(uuid.uuid4())
    graph_before, checkpointer_before = start()
    out = run(graph_before, ticket_id)
    assert "__interrupt__" in out
    assert out["review_reason"] == "KB article does not answer the ticket."
    checkpointer_before.close()

    graph_after, _ = start()
    assert is_paused(graph_after, ticket_id)
    waiting = graph_after.get_state(config(ticket_id)).values
    assert type(waiting["kb_grade"]) is dict
    assert waiting["kb_grade"] == {"relevant_topics": [], "reason": "Neither answers it.",
                                   "status": "rejected", "injection_suspected": False}
    assert waiting["kb_context"] == []

    final = resume_review(graph_after, ticket_id, ReviewDecision(action="edit", edited_reply="Hi."))
    assert final["final_reply"] == "Hi."
    assert final["kb_grade"]["status"] == "rejected"
    assert not is_paused(graph_after, ticket_id)
    assert len(fakes.grader.calls) == 1  # not called again on resume
    assert fakes.critic.calls == []


def test_a_kept_article_is_stored_and_read_back_as_a_kb_match(fakes, start):
    fakes.grader.result = KbGradeResult(relevant_topics=["account lockout"], reason="Yes.")
    fakes.critic.result = CritiqueResult(needs_human_review=True, reason="Look.")
    ticket_id = str(uuid.uuid4())
    graph_before, checkpointer_before = start()
    assert "__interrupt__" in run(graph_before, ticket_id)
    checkpointer_before.close()

    graph_after, _ = start()
    waiting = graph_after.get_state(config(ticket_id)).values
    assert [type(m) for m in waiting["kb_context"]] == [KbMatch]
    assert waiting["kb_context"][0].topic == "account lockout"
    assert waiting["kb_grade"]["status"] == "ok"
    final = resume_review(graph_after, ticket_id, ReviewDecision(action="approve"))
    assert final["final_reply"] == "We will follow up."


def test_a_paused_injection_flagged_run_resumes_with_injection_suspected_a_bool(fakes, start):
    fakes.grader.result = KbGradeResult(
        relevant_topics=["account lockout"], reason="Yes.", injection_suspected=True)
    ticket_id = str(uuid.uuid4())
    graph_before, checkpointer_before = start()
    out = run(graph_before, ticket_id)
    assert "__interrupt__" in out
    assert out["review_reason"] == "Possible prompt injection in the ticket."
    checkpointer_before.close()

    graph_after, _ = start()
    waiting = graph_after.get_state(config(ticket_id)).values
    assert type(waiting["kb_grade"]) is dict
    assert waiting["kb_grade"]["injection_suspected"] is True

    final = resume_review(graph_after, ticket_id, ReviewDecision(action="approve"))
    assert final["kb_grade"]["injection_suspected"] is True
    assert final["final_reply"] == "We will follow up."
    assert fakes.critic.calls == []
