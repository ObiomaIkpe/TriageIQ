"""POST /tickets/{id}/review against a real Postgres.

Tickets are created through POST /triage with Claude and the KB search faked. The graph
is the conftest's in-memory one (MemorySaver) unless a test says otherwise; the database
(rows, the row lock, commits and rollbacks) is real.
"""
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from app.api import review as review_api
from app.api.deps import get_graph
from app.config import settings
from app.graph import classifier, critic, kb_retrieval, reply_draft
from app.graph.critic import CritiqueResult
from app.graph.review import is_paused
from app.main import app
from app.models import (
    Category,
    ClassificationResult,
    KbMatch,
    TicketIn,
    TriageResult,
    Urgency,
)
from app.tickets import store
from app.tickets.reference import new_reference
from tests.helpers import ai_message

pytestmark = pytest.mark.integration

KEY = "dummy-review-key"
HEADERS = {"X-API-Key": KEY}
DRAFT = "Your lockout clears after 1 hour."
TICKET = {"subject": "Cannot log in", "body": "Account locked."}
# The gateway always sends who is reviewing (a machine client here); see tests/integration/test_reviewed_by_pg.py.
REVIEWER = {"id": "client:ops", "name": "ops"}


class FakeChain:
    def __init__(self, result):
        self.result = result

    def invoke(self, inputs):
        return self.result


@pytest.fixture
def fakes(monkeypatch, test_session):
    monkeypatch.setattr(settings, "review_api_key", KEY)

    class Fakes:
        pass

    f = Fakes()
    f.classify = FakeChain(ClassificationResult(
        category=Category.account, urgency=Urgency.high, confidence=0.95, reasoning="Locked.",
    ))
    f.critic = FakeChain(CritiqueResult(needs_human_review=True, reason="Needs a look."))
    monkeypatch.setattr(classifier, "_chain", f.classify)
    monkeypatch.setattr(reply_draft, "_chain", FakeChain(ai_message(DRAFT)))
    monkeypatch.setattr(critic, "_chain", f.critic)
    monkeypatch.setattr(
        kb_retrieval, "search_similar",
        lambda query_text, top_k: [KbMatch(topic="t", content="c", distance=0.3)],
    )
    return f


@pytest.fixture
def client(fakes):
    return TestClient(app)


@pytest.fixture
def graph(triage_graph_override):
    return triage_graph_override


def low_confidence(fakes):
    fakes.classify.result = ClassificationResult(
        category=Category.other, urgency=Urgency.low, confidence=0.3, reasoning="Unclear.",
    )


def create(client):
    """POST /triage and return the ticket id."""
    response = client.post("/triage", json=TICKET)
    assert response.status_code == 200, response.text
    return response.json()["ticket_id"]


def review(client, ticket_id, body, headers=HEADERS):
    return client.post(
        f"/tickets/{ticket_id}/review", json={"reviewer": REVIEWER, **body}, headers=headers
    )


def stored(ticket_id):
    return store.get_ticket(ticket_id)


# --- the happy paths ------------------------------------------------------------

def test_approving_a_flagged_ticket_with_a_draft(client, graph):
    ticket_id = create(client)
    assert is_paused(graph, ticket_id)

    response = review(client, ticket_id, {"action": "approve", "note": "looks right"})

    assert response.status_code == 200
    body = response.json()
    assert body["ticket_id"] == ticket_id
    assert body["status"] == "approved"
    assert body["final_reply"] == DRAFT
    assert body["review_note"] == "looks right"
    assert body["reviewed_at"] is not None
    assert not is_paused(graph, ticket_id)
    fetched = client.get(f"/tickets/{ticket_id}").json()
    assert (fetched["status"], fetched["final_reply"], fetched["review_note"]) == (
        "approved", DRAFT, "looks right",
    )
    assert fetched["reviewed_at"] == body["reviewed_at"]


def test_editing_a_low_confidence_ticket_that_has_no_draft(client, fakes, graph):
    low_confidence(fakes)
    ticket_id = create(client)

    response = review(client, ticket_id, {"action": "edit", "edited_reply": "We will call you."})

    assert response.status_code == 200
    assert response.json()["status"] == "edited"
    assert response.json()["final_reply"] == "We will call you."
    assert client.get(f"/tickets/{ticket_id}").json()["final_reply"] == "We will call you."
    assert not is_paused(graph, ticket_id)


def test_rejecting_a_low_confidence_ticket_that_has_no_draft(client, fakes, graph):
    low_confidence(fakes)
    ticket_id = create(client)

    response = review(client, ticket_id, {"action": "reject", "note": "spam"})

    assert response.status_code == 200
    assert response.json()["status"] == "rejected"
    assert response.json()["final_reply"] is None
    assert response.json()["review_note"] == "spam"
    assert not is_paused(graph, ticket_id)


def test_the_original_triage_fields_survive_a_review(client, graph):
    ticket_id = create(client)
    before = client.get(f"/tickets/{ticket_id}").json()

    after = review(client, ticket_id, {"action": "approve"}).json()

    for key in ("reference", "subject", "body", "category", "urgency", "routing_target",
                "suggested_reply", "kb_sources", "needs_human_review", "review_reason",
                "created_at"):
        assert after[key] == before[key], key


# --- refused reviews leave everything as it was ---------------------------------

def test_approving_a_ticket_with_no_draft_is_422_and_changes_nothing(client, fakes, graph):
    low_confidence(fakes)
    ticket_id = create(client)

    response = review(client, ticket_id, {"action": "approve"})

    assert response.status_code == 422
    assert "no draft" in response.json()["detail"]
    assert stored(ticket_id).status == "pending_review"
    assert stored(ticket_id).reviewed_at is None
    assert is_paused(graph, ticket_id)


def test_after_a_refused_approve_the_ticket_can_still_be_edited(client, fakes, graph):
    low_confidence(fakes)
    ticket_id = create(client)
    assert review(client, ticket_id, {"action": "approve"}).status_code == 422

    assert review(client, ticket_id, {"action": "edit", "edited_reply": "Hi."}).status_code == 200


def test_a_second_review_is_409_and_keeps_the_first_decision(client, graph):
    ticket_id = create(client)
    assert review(client, ticket_id, {"action": "approve", "note": "first"}).status_code == 200

    second = review(client, ticket_id, {"action": "reject", "note": "second"})

    assert second.status_code == 409
    assert second.json() == {"detail": "Ticket is not waiting for a review"}
    assert (stored(ticket_id).status, stored(ticket_id).review_note) == ("approved", "first")


def test_an_unknown_ticket_is_404(client):
    response = review(client, str(uuid4()), {"action": "approve"})

    assert response.status_code == 404
    assert response.json() == {"detail": "Ticket not found"}


def test_a_paused_thread_with_no_ticket_row_is_404(client, graph):
    # The known gap: the graph paused but the row was never saved.
    orphan = str(uuid4())
    graph.invoke({"ticket": TicketIn(**TICKET)}, {"configurable": {"thread_id": orphan}})
    assert is_paused(graph, orphan)

    response = review(client, orphan, {"action": "approve"})

    assert response.status_code == 404
    assert is_paused(graph, orphan)  # untouched


def test_a_pending_row_whose_thread_is_not_paused_is_409(client, graph):
    # A row that says pending_review, but the graph has no paused run for it.
    ticket_id = str(uuid4())
    store.save_ticket(TicketIn(**TICKET), TriageResult(
        ticket_id=ticket_id, reference=new_reference(), category=Category.account,
        urgency=Urgency.low, confidence=0.9, routing_target="general-queue",
        needs_human_review=True, review_reason="x",
    ))

    response = review(client, ticket_id, {"action": "approve"})

    assert response.status_code == 409
    assert stored(ticket_id).status == "pending_review"


def test_an_edit_without_text_is_422_and_the_graph_is_untouched(client, graph):
    ticket_id = create(client)
    before = graph.get_state({"configurable": {"thread_id": ticket_id}})

    for body in ({"action": "edit"}, {"action": "edit", "edited_reply": "  "}):
        assert review(client, ticket_id, body).status_code == 422

    after = graph.get_state({"configurable": {"thread_id": ticket_id}})
    assert after.next == before.next == ("human_review",)
    assert after.config == before.config  # no new checkpoint
    assert stored(ticket_id).status == "pending_review"


def test_a_malformed_ticket_id_is_422(client):
    assert review(client, "not-a-uuid", {"action": "approve"}).status_code == 422


# --- the key -------------------------------------------------------------------

def test_without_the_key_nothing_happens(client, graph):
    ticket_id = create(client)

    assert review(client, ticket_id, {"action": "approve"}, headers={}).status_code == 401
    assert review(client, ticket_id, {"action": "approve"}, headers={"X-API-Key": "x"}).status_code == 401

    assert stored(ticket_id).status == "pending_review"
    assert is_paused(graph, ticket_id)


def test_a_disabled_endpoint_changes_nothing(client, graph, monkeypatch):
    ticket_id = create(client)
    monkeypatch.setattr(settings, "review_api_key", "")

    assert review(client, ticket_id, {"action": "approve"}).status_code == 503

    assert stored(ticket_id).status == "pending_review"
    assert is_paused(graph, ticket_id)


# --- atomicity -----------------------------------------------------------------

def test_a_failure_after_the_graph_resumed_rolls_the_row_back(fakes, graph, monkeypatch):
    client = TestClient(app, raise_server_exceptions=False)
    ticket_id = create(client)

    def explode(*args, **kwargs):
        raise RuntimeError("the database went away")

    monkeypatch.setattr(review_api, "record_review", explode)
    response = review(client, ticket_id, {"action": "approve"})

    assert response.status_code == 500
    # The row is unchanged: the transaction rolled back.
    assert stored(ticket_id).status == "pending_review"
    assert stored(ticket_id).final_reply is None
    assert stored(ticket_id).reviewed_at is None
    # THE KNOWN GAP: the graph already finished before the failure and cannot be
    # un-resumed, so the row says pending_review for a run that is no longer paused.
    assert not is_paused(graph, ticket_id)
    # So a retry gets a 409, not a second chance.
    monkeypatch.setattr(review_api, "record_review", store.record_review)
    assert review(client, ticket_id, {"action": "approve"}).status_code == 409


def test_a_refusal_after_the_lock_rolls_back_without_changing_the_row(client, fakes, graph):
    low_confidence(fakes)
    ticket_id = create(client)

    assert review(client, ticket_id, {"action": "approve"}).status_code == 422

    # and the lock was released: another review goes straight through
    assert review(client, ticket_id, {"action": "reject"}).status_code == 200


# --- concurrency ---------------------------------------------------------------

HOLD_SECONDS = 0.5


def race(client_factory, ticket_ids, monkeypatch):
    """Two threads review each ticket at the same moment, once per ticket.

    The real resume_review is wrapped so the thread that gets into it sleeps while it
    still holds the row lock, which makes the overlap certain instead of lucky. Returns
    ({ticket_id: [(status_code, note), ...]}, {ticket_id: times resume_review ran}).
    """
    real = review_api.resume_review
    entered = {}
    guard = threading.Lock()

    def slow_resume(graph, ticket_id, decision):
        with guard:
            entered[ticket_id] = entered.get(ticket_id, 0) + 1
        result = real(graph, ticket_id, decision)
        time.sleep(HOLD_SECONDS)  # the winner holds the lock for this long
        return result

    monkeypatch.setattr(review_api, "resume_review", slow_resume)

    outcomes = {}
    for ticket_id in ticket_ids:
        barrier = threading.Barrier(2)

        def post(note):
            http = client_factory()
            barrier.wait()  # both threads fire together
            response = http.post(
                f"/tickets/{ticket_id}/review",
                json={"action": "approve", "note": note, "reviewer": REVIEWER},
                headers=HEADERS,
            )
            return response.status_code, note

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes[ticket_id] = list(pool.map(post, ["first", "second"]))
    return outcomes, entered


def test_two_simultaneous_reviews_of_the_same_ticket_one_wins(fakes, graph, monkeypatch):
    seed = TestClient(app)
    ticket_ids = [create(seed) for _ in range(4)]

    started = time.monotonic()
    outcomes, entered = race(lambda: TestClient(app), ticket_ids, monkeypatch)
    elapsed = time.monotonic() - started

    for ticket_id, results in outcomes.items():
        codes = sorted(code for code, _ in results)
        assert codes == [200, 409], (ticket_id, results)
        winner = next(note for code, note in results if code == 200)
        row = stored(ticket_id)
        assert row.status == "approved"
        assert row.review_note == winner  # the winner's values, not the loser's
        assert row.final_reply == DRAFT
        assert not is_paused(graph, ticket_id)
        # The loser waited at the row lock and then saw "approved": it never reached
        # resume_review. Without the lock both would have got in while the winner slept.
        assert entered[ticket_id] == 1, entered
    # Sanity: each race really did hold the lock for the sleep.
    assert elapsed >= HOLD_SECONDS * len(ticket_ids)


def test_two_simultaneous_reviews_with_different_decisions(fakes, graph, monkeypatch):
    seed = TestClient(app)
    ticket_id = create(seed)
    real = review_api.resume_review
    entered = []

    def slow_resume(graph_, ticket_id_, decision):
        entered.append(decision.action)
        result = real(graph_, ticket_id_, decision)
        time.sleep(HOLD_SECONDS)
        return result

    monkeypatch.setattr(review_api, "resume_review", slow_resume)
    barrier = threading.Barrier(2)

    def post(body):
        http = TestClient(app)
        barrier.wait()
        return http.post(
            f"/tickets/{ticket_id}/review", json={"reviewer": REVIEWER, **body}, headers=HEADERS
        ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        codes = list(pool.map(post, [{"action": "approve"}, {"action": "reject"}]))

    assert sorted(codes) == [200, 409]
    assert len(entered) == 1
    winner = entered[0]
    assert stored(ticket_id).status == {"approve": "approved", "reject": "rejected"}[winner]


# --- GET by reference ----------------------------------------------------------

def test_a_created_ticket_is_found_by_its_reference(client):
    posted = client.post("/triage", json=TICKET).json()

    response = client.get(f"/tickets/reference/{posted['reference']}")

    assert response.status_code == 200
    assert response.json()["ticket_id"] == posted["ticket_id"]


def test_an_unknown_reference_is_404(client):
    response = client.get("/tickets/reference/TKT-NOPE22")

    assert response.status_code == 404
    assert response.json() == {"detail": "Ticket not found"}


def test_reviewed_tickets_are_found_by_reference_with_their_review(client, graph):
    posted = client.post("/triage", json=TICKET).json()
    review(client, posted["ticket_id"], {"action": "approve", "note": "ok"})

    body = client.get(f"/tickets/reference/{posted['reference']}").json()

    assert (body["status"], body["final_reply"], body["review_note"]) == ("approved", DRAFT, "ok")


def test_the_race_on_a_real_postgres_checkpointer(fakes, migrated_database, monkeypatch):
    # Same race, but the paused graph state lives in Postgres (PostgresSaver), not memory.
    from app.graph.build import build_triage_graph
    from app.graph.checkpointer import create_checkpointer

    checkpointer = create_checkpointer(migrated_database)
    pg_graph = build_triage_graph(checkpointer.saver)
    app.dependency_overrides[get_graph] = lambda: pg_graph
    try:
        seed = TestClient(app)
        ticket_ids = [create(seed) for _ in range(2)]
        assert all(is_paused(pg_graph, t) for t in ticket_ids)

        outcomes, entered = race(lambda: TestClient(app), ticket_ids, monkeypatch)

        for ticket_id, results in outcomes.items():
            assert sorted(code for code, _ in results) == [200, 409], results
            winner = next(note for code, note in results if code == 200)
            assert stored(ticket_id).review_note == winner
            assert stored(ticket_id).status == "approved"
            assert not is_paused(pg_graph, ticket_id)
            assert entered[ticket_id] == 1
    finally:
        checkpointer.close()
