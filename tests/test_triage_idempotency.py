"""POST /triage with a ticket_id: the work is done at most once.

No database: the advisory lock, the row lookup and the save are faked, the graph is the
conftest's in-memory one, and Claude and the KB search are faked. The real-Postgres
versions are in tests/integration/test_idempotent_triage_pg.py.
"""
import contextlib
from types import SimpleNamespace
from uuid import UUID

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from app.api import triage as triage_api
from app.graph import classifier, critic, kb_retrieval, reply_draft
from app.graph.critic import CritiqueResult
from app.main import app
from app.models import (
    Category,
    ClassificationResult,
    KbMatch,
    TicketRecord,
    TicketStatus,
    Urgency,
)
from tests.helpers import ai_message

client = TestClient(app, raise_server_exceptions=False)

TID = "3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34"
TICKET = {"subject": "Cannot log in", "body": "Account locked.", "ticket_id": TID}
KB = KbMatch(topic="account lockout", content="Clears after 1 hour.", distance=0.33)


class Chain:
    def __init__(self, result):
        self.result = result
        self.calls = 0

    def invoke(self, inputs):
        self.calls += 1
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


@pytest.fixture
def world(monkeypatch, triage_graph_override):
    w = SimpleNamespace()
    w.confidence = 0.95
    w.classify = Chain(
        ClassificationResult(
            category=Category.account, urgency=Urgency.high, confidence=0.95, reasoning="r"
        )
    )
    w.draft = Chain(ai_message("Your lockout clears after 1 hour."))
    w.critic = Chain(CritiqueResult(needs_human_review=False, reason=""))
    monkeypatch.setattr(classifier, "_chain", w.classify)
    monkeypatch.setattr(reply_draft, "_chain", w.draft)
    monkeypatch.setattr(critic, "_chain", w.critic)
    monkeypatch.setattr(kb_retrieval, "search_similar", lambda query_text, top_k: [KB])

    w.rows = {}  # the "database": ticket id -> TicketRecord
    w.locks = []
    w.save_error = None

    @contextlib.contextmanager
    def lock(ticket_id):
        w.locks.append(ticket_id)
        yield

    def save(ticket, result):
        if w.save_error:
            raise w.save_error
        w.rows[result.ticket_id] = TicketRecord(
            **result.model_dump(),
            status=TicketStatus.pending_review if result.needs_human_review else TicketStatus.triaged,
            subject=ticket.subject,
            body=ticket.body,
            created_at="2026-11-21T10:00:00Z",
        )
        return result.reference

    monkeypatch.setattr(triage_api, "ticket_lock", lock)
    monkeypatch.setattr(triage_api, "save_ticket", save)
    monkeypatch.setattr(triage_api, "get_ticket", lambda ticket_id: w.rows.get(ticket_id))
    w.graph = triage_graph_override
    w.model_calls = lambda: w.classify.calls + w.draft.calls + w.critic.calls
    return w


def make_low_confidence(w):
    w.classify.result = ClassificationResult(
        category=Category.account, urgency=Urgency.high, confidence=0.2, reasoning="r"
    )


# --- the id itself -----------------------------------------------------------

@pytest.mark.parametrize("bad", ["abc", "123", "3f6b2c1e-8a4d-4b7e-9c10", 5, "", "not-a-uuid-at-all-xxxxxxxxxxxxxxxxxxxx"])
def test_a_malformed_ticket_id_is_a_422_and_nothing_runs(world, bad):
    response = client.post("/triage", json={**TICKET, "ticket_id": bad})
    assert response.status_code == 422
    assert world.model_calls() == 0
    assert world.locks == []


def test_a_null_ticket_id_means_no_id(world):
    response = client.post("/triage", json={**TICKET, "ticket_id": None})
    assert response.status_code == 200
    assert world.locks == []


def test_without_a_ticket_id_nothing_idempotent_is_touched(world, monkeypatch):
    monkeypatch.setattr(triage_api, "get_ticket", lambda _id: pytest.fail("looked up a row"))
    response = client.post("/triage", json={"subject": "s", "body": "b"})
    assert response.status_code == 200
    assert world.locks == []
    assert UUID(response.json()["ticket_id"])  # a generated one


def test_the_given_id_is_the_ticket_id_the_thread_id_and_is_locked(world):
    response = client.post("/triage", json=TICKET)
    assert response.status_code == 200
    assert response.json()["ticket_id"] == TID
    assert world.locks == [TID]
    assert world.graph.get_state({"configurable": {"thread_id": TID}}).values["classification"]
    assert TID in world.rows


def test_an_uppercase_id_is_normalised(world):
    response = client.post("/triage", json={**TICKET, "ticket_id": TID.upper()})
    assert response.json()["ticket_id"] == TID


# --- b) a row already exists -------------------------------------------------

def test_an_existing_row_is_returned_in_the_same_shape_with_no_model_calls(world):
    first = client.post("/triage", json=TICKET).json()
    calls = world.model_calls()
    assert calls == 3

    second = client.post("/triage", json=TICKET)

    assert second.status_code == 200
    assert second.json() == first  # same keys, same values, same reference
    assert set(second.json()) == set(first)
    assert world.model_calls() == calls
    assert len(world.rows) == 1


def test_a_reviewed_ticket_still_returns_its_triage_result(world):
    first = client.post("/triage", json=TICKET).json()
    world.rows[TID] = world.rows[TID].model_copy(update={"status": TicketStatus.approved})
    assert client.post("/triage", json=TICKET).json() == first


# --- c) no row, but the run left a checkpoint --------------------------------

def test_a_finished_checkpoint_without_a_row_is_rebuilt_without_model_calls(world):
    world.save_error = RuntimeError("database write failed")
    assert client.post("/triage", json=TICKET).status_code == 500  # run finished, save failed
    assert TID not in world.rows
    calls = world.model_calls()

    world.save_error = None
    response = client.post("/triage", json=TICKET)

    assert response.status_code == 200
    assert response.json()["category"] == "account"
    assert response.json()["suggested_reply"] == "Your lockout clears after 1 hour."
    assert response.json()["needs_human_review"] is False
    assert world.model_calls() == calls  # nothing was called again
    assert world.rows[TID].status == TicketStatus.triaged


def test_a_paused_checkpoint_without_a_row_is_rebuilt_saved_pending_and_still_resumable(world):
    make_low_confidence(world)
    world.save_error = RuntimeError("database write failed")
    assert client.post("/triage", json=TICKET).status_code == 500
    calls = world.model_calls()

    world.save_error = None
    response = client.post("/triage", json=TICKET)

    assert response.status_code == 200
    body = response.json()
    assert body["needs_human_review"] is True
    assert body["suggested_reply"] is None
    assert body["ticket_id"] == TID
    assert world.model_calls() == calls
    assert world.rows[TID].status == TicketStatus.pending_review
    # still paused, so the review endpoint can resume it
    from app.graph.review import is_paused

    assert is_paused(world.graph, TID)


def test_an_interrupted_checkpoint_is_cleared_and_the_run_starts_fresh(world, monkeypatch):
    world.draft.result = RuntimeError("boom")  # the run stops halfway
    assert client.post("/triage", json=TICKET).status_code == 500
    assert world.classify.calls == 1
    snapshot = world.graph.get_state({"configurable": {"thread_id": TID}})
    assert snapshot.next  # something is left to run

    deleted = []
    original = world.graph.checkpointer.delete_thread
    monkeypatch.setattr(
        world.graph.checkpointer, "delete_thread", lambda t: (deleted.append(t), original(t))[1]
    )
    world.draft.result = ai_message("A fresh reply.")
    response = client.post("/triage", json=TICKET)

    assert response.status_code == 200
    assert deleted == [TID]
    assert world.classify.calls == 2  # started again from the first step
    assert response.json()["suggested_reply"] == "A fresh reply."
    assert TID in world.rows


def test_a_thread_with_nothing_in_it_is_not_cleared(world, monkeypatch):
    monkeypatch.setattr(
        world.graph.checkpointer, "delete_thread", lambda t: pytest.fail("cleared an empty thread")
    )
    assert client.post("/triage", json=TICKET).status_code == 200


# --- the save race -----------------------------------------------------------

def _duplicate_id_error(constraint="tickets_pkey"):
    orig = SimpleNamespace(diag=SimpleNamespace(constraint_name=constraint))
    return IntegrityError("INSERT", {}, orig)


def test_a_primary_key_collision_on_save_returns_the_existing_row_not_a_500(world, monkeypatch):
    first = client.post("/triage", json=TICKET).json()
    # The row is invisible to the first lookup, then the save collides with it: the race.
    saved_row = world.rows.pop(TID)
    lookups = iter([None, saved_row])
    monkeypatch.setattr(triage_api, "get_ticket", lambda _id: next(lookups))
    world.save_error = _duplicate_id_error()

    response = client.post("/triage", json=TICKET)

    assert response.status_code == 200
    assert response.json() == first


def test_a_collision_on_another_constraint_is_not_hidden(world):
    world.save_error = _duplicate_id_error("something_else")
    assert client.post("/triage", json=TICKET).status_code == 500


def test_a_collision_with_no_row_to_return_is_not_hidden(world):
    world.save_error = _duplicate_id_error()
    assert client.post("/triage", json=TICKET).status_code == 500
