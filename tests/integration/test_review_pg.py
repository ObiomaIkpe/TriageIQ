"""A flagged ticket pauses on a real PostgresSaver and resumes after a simulated restart.

A "restart" here is a brand-new connection pool, saver and compiled graph, with the same
ticket id (= LangGraph thread id) as before. Claude and the KB search are faked.
"""
import uuid

import pytest

from app.graph import classifier, critic, kb_retrieval, reply_draft
from app.graph.build import build_triage_graph
from app.graph.checkpointer import create_checkpointer
from app.graph.critic import CritiqueResult
from app.graph.review import ReviewNotPending, is_paused, resume_review
from app.models import (
    Category,
    ClassificationResult,
    KbMatch,
    ReviewDecision,
    TicketIn,
    Urgency,
)
from tests.helpers import ai_message

pytestmark = pytest.mark.integration

DRAFT = "Your lockout clears after 1 hour."
KB_MATCH = KbMatch(topic="account lockout", content="Lockout clears after 1 hour.", distance=0.33)


class FakeChain:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def invoke(self, inputs):
        self.calls.append(inputs)
        return self.result


@pytest.fixture
def fakes(monkeypatch):
    class Fakes:
        pass

    f = Fakes()
    f.classify = FakeChain(
        ClassificationResult(
            category=Category.account, urgency=Urgency.high, confidence=0.95, reasoning="Locked."
        )
    )
    f.draft = FakeChain(ai_message(DRAFT))
    f.critic = FakeChain(CritiqueResult(needs_human_review=True, reason="Needs a look."))
    f.kb_calls = []

    def _search(query_text, top_k):
        f.kb_calls.append(query_text)
        return [KB_MATCH]

    monkeypatch.setattr(classifier, "_chain", f.classify)
    monkeypatch.setattr(reply_draft, "_chain", f.draft)
    monkeypatch.setattr(critic, "_chain", f.critic)
    monkeypatch.setattr(kb_retrieval, "search_similar", _search)
    return f


@pytest.fixture
def start(clean_database):
    """start() -> (graph, checkpointer): a fresh pool, saver and compiled graph each time."""
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


def chain_calls(fakes):
    return (len(fakes.classify.calls), len(fakes.draft.calls), len(fakes.critic.calls), len(fakes.kb_calls))


def test_a_flagged_ticket_pauses_and_resumes_after_a_restart(fakes, start, caplog):
    ticket_id = str(uuid.uuid4())

    graph_before, checkpointer_before = start()
    out = run(graph_before, ticket_id)
    assert "__interrupt__" in out
    assert is_paused(graph_before, ticket_id)
    checkpointer_before.close()  # the "process" ends

    graph_after, _ = start()  # a new pool, saver and graph
    assert is_paused(graph_after, ticket_id)
    with caplog.at_level("WARNING"):
        waiting = graph_after.get_state(config(ticket_id)).values
        final = resume_review(graph_after, ticket_id, ReviewDecision(action="approve", note="ok"))

    # the allowlisted classes survived the trip through Postgres
    assert type(waiting["ticket"]) is TicketIn
    assert type(waiting["classification"]) is ClassificationResult
    assert type(waiting["classification"].category) is Category
    assert type(waiting["kb_context"][0]) is KbMatch
    # and the review finished correctly
    assert final["final_reply"] == DRAFT
    assert final["review_decision"] == {"action": "approve", "edited_reply": None, "note": "ok"}
    assert type(final["ticket"]) is TicketIn
    assert graph_after.get_state(config(ticket_id)).next == ()
    assert not is_paused(graph_after, ticket_id)
    assert "unregistered" not in caplog.text
    assert "Blocked" not in caplog.text


def test_nothing_is_called_again_across_the_restart_and_resume(fakes, start):
    ticket_id = str(uuid.uuid4())
    graph_before, checkpointer_before = start()
    run(graph_before, ticket_id)
    assert chain_calls(fakes) == (1, 1, 1, 1)
    checkpointer_before.close()

    graph_after, _ = start()
    resume_review(graph_after, ticket_id, ReviewDecision(action="reject"))

    assert chain_calls(fakes) == (1, 1, 1, 1)


def test_a_low_confidence_ticket_is_edited_after_a_restart(fakes, start):
    fakes.classify.result = ClassificationResult(
        category=Category.other, urgency=Urgency.low, confidence=0.4, reasoning="Unclear."
    )
    ticket_id = str(uuid.uuid4())
    graph_before, checkpointer_before = start()
    run(graph_before, ticket_id)
    assert is_paused(graph_before, ticket_id)
    checkpointer_before.close()

    graph_after, _ = start()
    final = resume_review(
        graph_after, ticket_id, ReviewDecision(action="edit", edited_reply="We will call you.")
    )

    assert final["final_reply"] == "We will call you."
    assert final["review_decision"]["action"] == "edit"
    assert chain_calls(fakes) == (1, 0, 0, 0)


def test_a_reject_after_a_restart_gives_no_final_reply(fakes, start):
    ticket_id = str(uuid.uuid4())
    graph_before, checkpointer_before = start()
    run(graph_before, ticket_id)
    checkpointer_before.close()

    graph_after, _ = start()
    final = resume_review(graph_after, ticket_id, ReviewDecision(action="reject", note="wrong"))

    assert final["final_reply"] is None
    assert final["review_decision"]["note"] == "wrong"


def test_a_second_resume_is_refused_even_from_another_restart(fakes, start):
    ticket_id = str(uuid.uuid4())
    graph_one, checkpointer_one = start()
    run(graph_one, ticket_id)
    checkpointer_one.close()

    graph_two, checkpointer_two = start()
    resume_review(graph_two, ticket_id, ReviewDecision(action="approve"))
    checkpointer_two.close()

    graph_three, _ = start()
    with pytest.raises(ReviewNotPending):
        resume_review(graph_three, ticket_id, ReviewDecision(action="reject"))


def test_an_unknown_ticket_id_is_refused_on_a_real_saver(fakes, start):
    graph, _ = start()

    assert is_paused(graph, str(uuid.uuid4())) is False
    with pytest.raises(ReviewNotPending):
        resume_review(graph, str(uuid.uuid4()), ReviewDecision(action="approve"))


def test_an_unflagged_ticket_does_not_pause_on_a_real_saver(fakes, start):
    fakes.critic.result = CritiqueResult(needs_human_review=False, reason="")
    ticket_id = str(uuid.uuid4())
    graph, _ = start()

    out = run(graph, ticket_id)

    assert "__interrupt__" not in out
    assert not is_paused(graph, ticket_id)
    assert graph.get_state(config(ticket_id)).next == ()
    with pytest.raises(ReviewNotPending):
        resume_review(graph, ticket_id, ReviewDecision(action="approve"))


def test_two_paused_tickets_survive_a_restart_independently(fakes, start):
    first, second = str(uuid.uuid4()), str(uuid.uuid4())
    graph_before, checkpointer_before = start()
    run(graph_before, first)
    run(graph_before, second)
    checkpointer_before.close()

    graph_after, _ = start()
    resume_review(graph_after, first, ReviewDecision(action="approve"))

    assert not is_paused(graph_after, first)
    assert is_paused(graph_after, second)
