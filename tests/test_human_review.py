"""The human_review pause: a flagged ticket stops, a decision resumes it.

Claude and the KB search are faked; the graph, the router and the API mapping run for
real, on the MemorySaver graph that tests/conftest.py installs.
"""
import json
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from langgraph.types import Command
from pydantic import ValidationError

from app.api import triage as triage_api
from app.graph import classifier, critic, kb_retrieval, reply_draft
from app.graph import human_review as human_review_module
from app.graph.critic import CritiqueResult
from app.graph.human_review import human_review
from app.graph.review import ReviewNotPending, is_paused, resume_review
from app.main import app
from app.models import (
    Category,
    ClassificationResult,
    KbMatch,
    ReviewDecision,
    TicketIn,
    Urgency,
)
from app.tickets import store as tickets_store
from tests.helpers import ai_message

DRAFT = "Your lockout clears after 1 hour."
CRITIC_REASON = "Reply adds a claim not in the article."
KB_MATCH = KbMatch(topic="account lockout", content="Lockout clears after 1 hour.", distance=0.33)
TICKET_ID = "11111111-1111-1111-1111-111111111111"
API_TICKET = {"subject": "Cannot log in", "body": "Account locked."}


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
    f.critic = FakeChain(CritiqueResult(needs_human_review=False, reason=""))
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
def graph(triage_graph_override):
    """The in-memory graph the autouse fixture in conftest.py installs."""
    return triage_graph_override


@pytest.fixture
def interrupt_calls(monkeypatch):
    """Counts how often the node reaches interrupt(), while still calling the real one."""
    from langgraph.types import interrupt as real_interrupt

    calls = []

    def counting(value):
        calls.append(value)
        return real_interrupt(value)

    monkeypatch.setattr(human_review_module, "interrupt", counting)
    return calls


def config(ticket_id=TICKET_ID):
    return {"configurable": {"thread_id": ticket_id}}


def run(graph, ticket_id=TICKET_ID):
    return graph.invoke(
        {"ticket": TicketIn(subject="Cannot log in", body="Account locked.")}, config(ticket_id)
    )


def flag_by_critic(fakes):
    fakes.critic.result = CritiqueResult(needs_human_review=True, reason=CRITIC_REASON)


def make_low_confidence(fakes):
    fakes.classify.result = ClassificationResult(
        category=Category.other, urgency=Urgency.low, confidence=0.4, reasoning="Unclear."
    )


def chain_calls(fakes):
    return (len(fakes.classify.calls), len(fakes.draft.calls), len(fakes.critic.calls), len(fakes.kb_calls))


# --- (a) an unflagged ticket does not pause ---------------------------------

def test_an_unflagged_ticket_runs_straight_through_without_pausing(fakes, graph):
    out = run(graph)

    assert "__interrupt__" not in out
    assert not is_paused(graph, TICKET_ID)
    assert graph.get_state(config()).next == ()


def test_an_unflagged_ticket_gets_no_final_reply_or_decision(fakes, graph):
    out = run(graph)

    assert "final_reply" not in out
    assert "review_decision" not in out
    assert out["needs_human_review"] is False


# --- (b) flagged by the critic ----------------------------------------------

def test_a_ticket_flagged_by_the_critic_pauses_at_human_review(fakes, graph):
    flag_by_critic(fakes)

    out = run(graph)

    assert "__interrupt__" in out
    assert is_paused(graph, TICKET_ID)
    assert graph.get_state(config()).next == ("human_review",)


def test_approving_gives_the_draft_as_the_final_reply(fakes, graph):
    flag_by_critic(fakes)
    run(graph)

    final = resume_review(graph, TICKET_ID, ReviewDecision(action="approve", note="looks right"))

    assert final["final_reply"] == DRAFT
    assert final["review_decision"] == {"action": "approve", "edited_reply": None, "note": "looks right"}
    assert not is_paused(graph, TICKET_ID)
    assert graph.get_state(config()).next == ()


# --- (c) flagged by low confidence (no draft exists) ------------------------

def test_a_low_confidence_ticket_pauses_even_though_it_has_no_draft(fakes, graph):
    make_low_confidence(fakes)

    out = run(graph)

    assert "__interrupt__" in out
    assert is_paused(graph, TICKET_ID)
    assert "draft_reply" not in graph.get_state(config()).values


def test_editing_gives_the_edited_text_as_the_final_reply(fakes, graph):
    make_low_confidence(fakes)
    run(graph)

    final = resume_review(
        graph, TICKET_ID, ReviewDecision(action="edit", edited_reply="We will get back to you today.")
    )

    assert final["final_reply"] == "We will get back to you today."
    assert final["review_decision"]["action"] == "edit"
    assert final["review_decision"]["edited_reply"] == "We will get back to you today."


def test_approving_a_ticket_that_has_no_draft_gives_no_final_reply(fakes, graph):
    # There is nothing to approve; the spec says approve -> draft_reply, which is absent.
    make_low_confidence(fakes)
    run(graph)

    final = resume_review(graph, TICKET_ID, ReviewDecision(action="approve"))

    assert final["final_reply"] is None
    assert final["review_decision"]["action"] == "approve"


# --- (d) reject --------------------------------------------------------------

def test_rejecting_gives_no_final_reply_and_stores_the_decision(fakes, graph):
    flag_by_critic(fakes)
    run(graph)

    final = resume_review(graph, TICKET_ID, ReviewDecision(action="reject", note="wrong policy"))

    assert final["final_reply"] is None
    assert final["review_decision"] == {"action": "reject", "edited_reply": None, "note": "wrong policy"}
    assert not is_paused(graph, TICKET_ID)


def test_the_stored_decision_is_a_plain_dict_in_the_saved_state(fakes, graph):
    flag_by_critic(fakes)
    run(graph)
    resume_review(graph, TICKET_ID, ReviewDecision(action="reject"))

    saved = graph.get_state(config()).values

    assert type(saved["review_decision"]) is dict
    assert saved["final_reply"] is None


# --- (e) an invalid decision is rejected ------------------------------------

@pytest.mark.parametrize("edited_reply", [None, "", "   ", "\n\t "])
def test_an_edit_without_real_text_is_invalid(edited_reply):
    with pytest.raises(ValidationError):
        ReviewDecision(action="edit", edited_reply=edited_reply)


def test_an_unknown_action_is_invalid():
    with pytest.raises(ValidationError):
        ReviewDecision(action="delete")


def test_an_edit_keeps_the_text_exactly_as_given():
    assert ReviewDecision(action="edit", edited_reply="  hello  ").edited_reply == "  hello  "


def test_approve_and_reject_do_not_need_any_text():
    assert ReviewDecision(action="approve").edited_reply is None
    assert ReviewDecision(action="reject").edited_reply is None


@pytest.mark.parametrize("raw", [{"action": "edit"}, {"action": "delete"}, "approve"])
def test_a_bad_raw_resume_value_is_a_clear_error_and_the_ticket_stays_pending(fakes, graph, raw):
    # Bypasses resume_review on purpose: the node must defend itself too.
    flag_by_critic(fakes)
    run(graph)

    with pytest.raises(ValueError, match="Invalid review decision"):
        graph.invoke(Command(resume=raw), config())

    assert is_paused(graph, TICKET_ID)
    assert "final_reply" not in graph.get_state(config()).values


@pytest.mark.xfail(
    strict=True,
    reason="KNOWN LIMITATION: LangGraph keeps the bad resume value as the task's pending "
    "write and hands it back on every later resume, so the ticket is stuck. Only reachable "
    "by bypassing resume_review. If this starts passing, LangGraph fixed it: remove the marker.",
)
def test_a_valid_resume_after_a_bad_raw_resume_succeeds(fakes, graph):
    flag_by_critic(fakes)
    run(graph)
    with pytest.raises(ValueError):
        graph.invoke(Command(resume={"action": "edit"}), config())

    final = resume_review(graph, TICKET_ID, ReviewDecision(action="approve"))

    assert final["final_reply"] == DRAFT


@pytest.mark.parametrize("raw", [None, {}])
def test_resume_values_langgraph_cannot_use_never_complete_the_review(fakes, graph, raw):
    # Command(resume=None) trips an internal UnboundLocalError in langgraph 1.2.16 and
    # Command(resume={}) is silently a no-op (an empty dict reads as an empty id->value map).
    # resume_review can never send either (model_dump() always has three keys); this pins
    # only the part that matters: the review is not completed by accident.
    flag_by_critic(fakes)
    run(graph)

    try:
        graph.invoke(Command(resume=raw), config())
    except Exception:
        pass

    assert is_paused(graph, TICKET_ID)
    assert "final_reply" not in graph.get_state(config()).values


# --- (f) resuming something that is not waiting -----------------------------

def test_resuming_an_unknown_ticket_raises(fakes, graph):
    with pytest.raises(ReviewNotPending):
        resume_review(graph, "no-such-ticket", ReviewDecision(action="approve"))


def test_a_second_resume_of_the_same_ticket_raises(fakes, graph):
    flag_by_critic(fakes)
    run(graph)
    resume_review(graph, TICKET_ID, ReviewDecision(action="approve"))

    with pytest.raises(ReviewNotPending):
        resume_review(graph, TICKET_ID, ReviewDecision(action="reject"))


def test_an_unflagged_ticket_cannot_be_resumed(fakes, graph):
    run(graph)

    with pytest.raises(ReviewNotPending):
        resume_review(graph, TICKET_ID, ReviewDecision(action="approve"))


def test_not_pending_is_detected_before_anything_is_invoked(fakes, graph):
    class SpyGraph:
        def __init__(self, inner):
            self.inner = inner
            self.invokes = []

        def get_state(self, cfg):
            return self.inner.get_state(cfg)

        def invoke(self, *args, **kwargs):
            self.invokes.append(args)
            return self.inner.invoke(*args, **kwargs)

    spy = SpyGraph(graph)
    with pytest.raises(ReviewNotPending):
        resume_review(spy, "no-such-ticket", ReviewDecision(action="approve"))

    flag_by_critic(fakes)
    run(graph)
    resume_review(graph, TICKET_ID, ReviewDecision(action="approve"))
    with pytest.raises(ReviewNotPending):
        resume_review(spy, TICKET_ID, ReviewDecision(action="approve"))

    assert spy.invokes == []


def test_is_paused_is_false_for_an_unknown_ticket(fakes, graph):
    assert is_paused(graph, "no-such-ticket") is False


# --- (g) re-run safety --------------------------------------------------------

def test_resuming_does_not_call_the_classifier_drafter_critic_or_kb_again(fakes, graph):
    flag_by_critic(fakes)
    run(graph)
    assert chain_calls(fakes) == (1, 1, 1, 1)

    resume_review(graph, TICKET_ID, ReviewDecision(action="approve"))

    assert chain_calls(fakes) == (1, 1, 1, 1)


def test_resuming_a_low_confidence_ticket_does_not_call_anything_again(fakes, graph):
    make_low_confidence(fakes)
    run(graph)
    assert chain_calls(fakes) == (1, 0, 0, 0)

    resume_review(graph, TICKET_ID, ReviewDecision(action="reject"))

    assert chain_calls(fakes) == (1, 0, 0, 0)


def test_the_review_node_itself_runs_again_from_its_start_on_resume(fakes, graph, interrupt_calls):
    # The documented LangGraph behaviour that human_review.py warns about, observed here.
    flag_by_critic(fakes)

    run(graph)
    assert len(interrupt_calls) == 1  # reached interrupt(), which paused the run

    resume_review(graph, TICKET_ID, ReviewDecision(action="approve"))
    assert len(interrupt_calls) == 2  # the node ran again and reached interrupt() again


def test_two_tickets_pause_and_resume_independently(fakes, graph):
    flag_by_critic(fakes)
    run(graph, "ticket-one")
    run(graph, "ticket-two")

    resume_review(graph, "ticket-one", ReviewDecision(action="approve"))

    assert not is_paused(graph, "ticket-one")
    assert is_paused(graph, "ticket-two")


# --- the node itself ----------------------------------------------------------

def test_the_node_returns_an_empty_dict_without_reaching_interrupt_when_not_flagged(monkeypatch):
    def must_not_be_called(value):
        raise AssertionError("interrupt() must not be reached for an unflagged ticket")

    monkeypatch.setattr(human_review_module, "interrupt", must_not_be_called)

    assert human_review({"needs_human_review": False}) == {}
    assert human_review({}) == {}


def test_the_interrupt_payload_is_small_plain_json_safe_values(fakes, graph):
    flag_by_critic(fakes)
    run(graph)

    payload = graph.get_state(config()).tasks[0].interrupts[0].value

    assert payload == {
        "review_reason": CRITIC_REASON,
        "suggested_reply": DRAFT,
        "category": "account",
        "urgency": "high",
        "routing_target": "account-management-urgent",
    }
    assert all(type(v) is str for v in payload.values())
    json.dumps(payload)


def test_the_payload_for_a_low_confidence_ticket_has_no_reply(fakes, graph):
    make_low_confidence(fakes)
    run(graph)

    payload = graph.get_state(config()).tasks[0].interrupts[0].value

    assert payload["suggested_reply"] is None
    assert payload["review_reason"] == "Low classifier confidence."
    assert payload["category"] == "other" and payload["urgency"] == "low"
    json.dumps(payload)


def test_the_node_returns_only_the_two_keys_it_writes(monkeypatch):
    monkeypatch.setattr(human_review_module, "interrupt", lambda value: {"action": "approve"})
    state = {
        "needs_human_review": True,
        "review_reason": "r",
        "draft_reply": "d",
        "routing_target": "t",
        "classification": ClassificationResult(
            category=Category.account, urgency=Urgency.low, confidence=0.9, reasoning="x"
        ),
    }

    result = human_review(state)

    assert set(result) == {"review_decision", "final_reply"}
    assert result["final_reply"] == "d"


# --- through POST /triage -------------------------------------------------------

@pytest.fixture
def api(monkeypatch, fakes):
    class Api:
        pass

    a = Api()
    a.saved = []
    a.client = TestClient(app)
    monkeypatch.setattr(triage_api, "uuid4", lambda: UUID(TICKET_ID))
    monkeypatch.setattr(triage_api, "new_reference", lambda: REFERENCE)

    def save(ticket, result):
        a.saved.append((ticket, result))
        return result.reference

    monkeypatch.setattr(triage_api, "save_ticket", save)
    return a


REFERENCE = "TKT-ABC234"

EXPECTED_KEYS = {
    "ticket_id", "reference", "category", "urgency", "confidence", "routing_target", "suggested_reply",
    "kb_sources", "needs_human_review", "review_reason",
}


def test_a_flagged_ticket_returns_the_usual_json_and_no_interrupt_key(api, fakes, graph):
    flag_by_critic(fakes)

    response = api.client.post("/triage", json=API_TICKET)

    assert response.status_code == 200
    body = response.json()
    assert set(body) == EXPECTED_KEYS
    assert "__interrupt__" not in response.text
    assert body == {
        "ticket_id": TICKET_ID,
        "reference": REFERENCE,
        "category": "account",
        "urgency": "high",
        "confidence": 0.95,
        "routing_target": "account-management-urgent",
        "suggested_reply": DRAFT,
        "kb_sources": [KB_MATCH.model_dump()],
        "needs_human_review": True,
        "review_reason": CRITIC_REASON,
    }


def test_a_flagged_ticket_has_the_same_json_shape_as_an_unflagged_one(api, fakes, graph):
    unflagged = api.client.post("/triage", json=API_TICKET).json()
    flag_by_critic(fakes)
    flagged = api.client.post("/triage", json=API_TICKET).json()

    assert set(flagged) == set(unflagged) == EXPECTED_KEYS


def test_a_flagged_ticket_is_saved_as_pending_review_and_the_run_is_paused(api, fakes, graph):
    flag_by_critic(fakes)

    api.client.post("/triage", json=API_TICKET)

    ticket, result = api.saved[0]
    assert result.needs_human_review is True
    assert tickets_store._to_row(ticket, result).status == "pending_review"
    assert is_paused(graph, TICKET_ID)


def test_an_unflagged_ticket_is_saved_as_triaged_and_is_not_paused(api, fakes, graph):
    api.client.post("/triage", json=API_TICKET)

    ticket, result = api.saved[0]
    assert tickets_store._to_row(ticket, result).status == "triaged"
    assert not is_paused(graph, TICKET_ID)


def test_a_low_confidence_ticket_through_the_api_is_flagged_saved_and_paused(api, fakes, graph):
    make_low_confidence(fakes)

    body = api.client.post("/triage", json=API_TICKET).json()

    assert set(body) == EXPECTED_KEYS
    assert body["suggested_reply"] is None and body["kb_sources"] == []
    assert body["review_reason"] == "Low classifier confidence."
    assert tickets_store._to_row(*api.saved[0]).status == "pending_review"
    assert is_paused(graph, TICKET_ID)


def test_a_ticket_created_through_the_api_can_then_be_reviewed(api, fakes, graph):
    flag_by_critic(fakes)
    ticket_id = api.client.post("/triage", json=API_TICKET).json()["ticket_id"]

    final = resume_review(graph, ticket_id, ReviewDecision(action="edit", edited_reply="Edited."))

    assert final["final_reply"] == "Edited."
    assert not is_paused(graph, ticket_id)
