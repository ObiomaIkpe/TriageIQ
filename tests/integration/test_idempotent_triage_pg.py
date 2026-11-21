"""POST /triage with a ticket_id against a real Postgres: rows, the advisory lock, and a
real PostgresSaver checkpointer (so the checkpoint read and delete_thread are the real ones).

Claude and the KB search are faked. Runs only with TEST_DATABASE_URL (a *_test database).
"""
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app import db
from app.api import triage as triage_api
from app.api.deps import get_graph
from app.config import settings
from app.graph import classifier, critic, kb_retrieval, reply_draft
from app.graph.build import build_triage_graph
from app.graph.checkpointer import create_checkpointer
from app.graph.critic import CritiqueResult
from app.graph.review import is_paused
from app.main import app
from app.models import Category, ClassificationResult, KbMatch, Urgency
from app.tickets import store
from tests.helpers import ai_message

pytestmark = pytest.mark.integration

client = TestClient(app, raise_server_exceptions=False)
TID = "3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34"
TICKET = {"subject": "Cannot log in", "body": "Account locked.", "customer_id": "c1", "ticket_id": TID}
KEY = "dummy-review-key"


class Chain:
    def __init__(self, result, delay=0.0):
        self.result, self.delay, self.calls = result, delay, 0
        self._lock = threading.Lock()

    def invoke(self, inputs):
        with self._lock:
            self.calls += 1
        time.sleep(self.delay)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


@pytest.fixture
def world(monkeypatch, test_session, migrated_database):
    monkeypatch.setattr(settings, "review_api_key", KEY)
    checkpointer = create_checkpointer(migrated_database)
    graph = build_triage_graph(checkpointer.saver)
    app.dependency_overrides[get_graph] = lambda: graph

    w = SimpleNamespace(graph=graph, factory=test_session)
    w.classify = Chain(
        ClassificationResult(category=Category.account, urgency=Urgency.high, confidence=0.95, reasoning="r"),
        delay=0.4,
    )
    w.draft = Chain(ai_message("Your lockout clears after 1 hour."))
    w.critic = Chain(CritiqueResult(needs_human_review=False, reason=""))
    monkeypatch.setattr(classifier, "_chain", w.classify)
    monkeypatch.setattr(reply_draft, "_chain", w.draft)
    monkeypatch.setattr(critic, "_chain", w.critic)
    monkeypatch.setattr(
        kb_retrieval, "search_similar",
        lambda query_text, top_k: [KbMatch(topic="t", content="c", distance=0.3)],
    )
    w.model_calls = lambda: w.classify.calls + w.draft.calls + w.critic.calls

    def rows():
        with test_session() as s:
            return s.execute(text("SELECT id::text, status, reference FROM tickets ORDER BY id")).all()

    def checkpoint_rows():
        with checkpointer.pool.connection() as conn:
            return conn.execute(
                "SELECT count(*) AS c FROM checkpoints WHERE thread_id = %s", (TID,)
            ).fetchone()["c"]

    w.rows, w.checkpoint_rows = rows, checkpoint_rows
    yield w
    app.dependency_overrides.pop(get_graph, None)
    checkpointer.close()


def test_the_same_ticket_id_twice_gives_one_row_one_run_and_the_same_response(world):
    first = client.post("/triage", json=TICKET)
    calls = world.model_calls()
    second = client.post("/triage", json=TICKET)

    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert first.json()["ticket_id"] == TID
    assert world.model_calls() == calls == 3
    assert [r[0] for r in world.rows()] == [TID]


def test_a_ticket_id_in_the_checkpoint_survives_the_real_serializer(world):
    client.post("/triage", json=TICKET)
    values = world.graph.get_state({"configurable": {"thread_id": TID}}).values
    assert str(values["ticket"].ticket_id) == TID


def test_a_paused_run_with_no_row_is_rebuilt_saved_pending_and_resumable(world):
    world.classify.result = ClassificationResult(
        category=Category.account, urgency=Urgency.high, confidence=0.2, reasoning="r"
    )
    first = client.post("/triage", json=TICKET).json()
    assert first["needs_human_review"] is True
    # The app "stopped" after the graph paused and before the row was saved.
    with world.factory.begin() as s:
        s.execute(text("DELETE FROM tickets"))
    assert world.rows() == []
    calls = world.model_calls()

    again = client.post("/triage", json=TICKET)

    assert again.status_code == 200
    body = again.json()
    assert body["ticket_id"] == TID and body["needs_human_review"] is True
    assert body["category"] == first["category"] and body["routing_target"] == first["routing_target"]
    assert world.model_calls() == calls
    assert [(r[0], r[1]) for r in world.rows()] == [(TID, "pending_review")]
    assert is_paused(world.graph, TID)

    reviewed = client.post(
        f"/tickets/{TID}/review",
        json={"action": "edit", "edited_reply": "A human wrote this."},
        headers={"X-API-Key": KEY},
    )
    assert reviewed.status_code == 200
    assert reviewed.json()["status"] == "edited"
    assert reviewed.json()["final_reply"] == "A human wrote this."


def test_a_finished_run_with_no_row_is_rebuilt_without_model_calls(world):
    first = client.post("/triage", json=TICKET).json()
    with world.factory.begin() as s:
        s.execute(text("DELETE FROM tickets"))
    calls = world.model_calls()

    again = client.post("/triage", json=TICKET)

    assert again.status_code == 200
    assert {k: v for k, v in again.json().items() if k != "reference"} == {
        k: v for k, v in first.items() if k != "reference"
    }
    assert world.model_calls() == calls
    assert [r[1] for r in world.rows()] == ["triaged"]


def test_an_interrupted_run_has_its_thread_cleared_and_runs_fresh(world):
    world.draft.result = RuntimeError("boom")
    assert client.post("/triage", json=TICKET).status_code == 500
    assert world.rows() == []
    assert world.checkpoint_rows() > 0
    assert world.classify.calls == 1

    world.draft.result = ai_message("A fresh reply.")
    again = client.post("/triage", json=TICKET)

    assert again.status_code == 200
    assert again.json()["suggested_reply"] == "A fresh reply."
    assert world.classify.calls == 2
    assert [r[0] for r in world.rows()] == [TID]
    # one clean run's checkpoints, not the old ones piled on top
    assert not world.graph.get_state({"configurable": {"thread_id": TID}}).next


def test_two_concurrent_requests_with_the_same_id_run_once_and_agree(world):
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(client.post, "/triage", json=TICKET) for _ in range(2)]
        responses = [f.result() for f in futures]

    assert [r.status_code for r in responses] == [200, 200]
    assert responses[0].json() == responses[1].json()
    assert world.classify.calls == 1  # one graph run
    assert world.model_calls() == 3
    assert [r[0] for r in world.rows()] == [TID]


def test_five_concurrent_requests_still_run_once(world):
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(client.post, "/triage", json=TICKET) for _ in range(5)]
        bodies = [f.result().json() for f in futures]
    assert all(b == bodies[0] for b in bodies)
    assert world.classify.calls == 1
    assert len(world.rows()) == 1


def test_a_different_id_is_not_blocked_by_a_held_lock(world):
    other = {**TICKET, "ticket_id": "00000000-0000-4000-8000-000000000002"}
    with store.ticket_lock(TID):  # someone is busy with TID ...
        response = client.post("/triage", json=other)  # ... and this one goes straight through
    assert response.status_code == 200
    assert [r[0] for r in world.rows()] == [other["ticket_id"]]


def test_a_real_primary_key_collision_returns_the_existing_row(world, monkeypatch):
    first = client.post("/triage", json=TICKET).json()
    # The lookup misses the row (as if another request had not committed yet) and the save
    # then hits the real primary key.
    real_get = triage_api.get_ticket
    seen = []

    def blind_once(ticket_id):
        seen.append(ticket_id)
        return None if len(seen) == 1 else real_get(ticket_id)

    monkeypatch.setattr(triage_api, "get_ticket", blind_once)
    again = client.post("/triage", json=TICKET)

    assert again.status_code == 200
    assert again.json() == first
    assert len(world.rows()) == 1


# --- the advisory lock itself -------------------------------------------------

def _try_lock(session, ticket_id):
    return session.execute(
        text("SELECT pg_try_advisory_lock(hashtextextended('triageiq:ticket:' || :id, 0))"),
        {"id": ticket_id},
    ).scalar()


def test_the_lock_is_held_inside_the_block_and_free_after_it(world):
    with world.factory() as other:
        with store.ticket_lock(TID):
            assert _try_lock(other, TID) is False  # held
            assert _try_lock(other, "00000000-0000-4000-8000-000000000009") is True  # another id is free
        assert _try_lock(other, TID) is True  # released
        other.execute(text("SELECT pg_advisory_unlock_all()"))


def test_the_lock_is_released_when_the_block_raises(world):
    with pytest.raises(RuntimeError):
        with store.ticket_lock(TID):
            raise RuntimeError("boom")
    with world.factory() as other:
        assert _try_lock(other, TID) is True
        other.execute(text("SELECT pg_advisory_unlock_all()"))


def test_a_connection_going_back_to_the_pool_has_no_lock_and_no_lock_timeout(world):
    with store.ticket_lock(TID):
        pass
    with world.factory() as s:
        assert s.execute(text("SHOW lock_timeout")).scalar() == "0"
        held = s.execute(text("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory'")).scalar()
        assert held == 0


def test_a_waiting_request_gives_up_with_a_database_error_after_the_lock_timeout(world, monkeypatch):
    monkeypatch.setattr(store, "TICKET_LOCK_TIMEOUT", "300ms")
    import sqlalchemy.exc

    with store.ticket_lock(TID):
        started = time.monotonic()
        with pytest.raises(sqlalchemy.exc.OperationalError):  # the 503 + Retry-After path
            with store.ticket_lock(TID):
                pass
        assert 0.25 < time.monotonic() - started < 3
    with store.ticket_lock(TID):  # and the first holder's lock was never affected
        pass
