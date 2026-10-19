"""record_review, get_ticket_by_reference and the reference-collision retry, on Postgres."""
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from app.graph import classifier, critic, kb_retrieval, reply_draft
from app.graph.critic import CritiqueResult
from app.main import app
from app.models import (
    Category,
    ClassificationResult,
    KbMatch,
    ReviewDecision,
    TicketIn,
    TicketStatus,
    TriageResult,
    Urgency,
)
from app.tickets import store
from app.tickets.orm import TicketRow
from app.tickets.reference import new_reference
from tests.helpers import ai_message

pytestmark = pytest.mark.integration

TICKET_IN = TicketIn(subject="Cannot log in", body="Account locked.")


def make_result(needs_human_review=True, reference=None, ticket_id=None) -> TriageResult:
    return TriageResult(
        ticket_id=ticket_id or str(uuid4()),
        reference=reference or new_reference(),
        category=Category.account,
        urgency=Urgency.high,
        confidence=0.95,
        routing_target="account-management-urgent",
        suggested_reply="Your lockout clears after 1 hour.",
        needs_human_review=needs_human_review,
        review_reason="Needs a look." if needs_human_review else None,
    )


def saved(needs_human_review=True):
    result = make_result(needs_human_review=needs_human_review)
    store.save_ticket(TICKET_IN, result)
    return result


def review(test_session, ticket_id, decision, final_reply):
    with test_session.begin() as session:
        return store.record_review(session, ticket_id, decision, final_reply)


def raw_row(test_session, ticket_id):
    with test_session() as session:
        row = session.get(TicketRow, UUID(ticket_id))
        session.expunge(row)
        return row


# --- record_review ----------------------------------------------------------

@pytest.mark.parametrize("action,status,final_reply", [
    ("approve", TicketStatus.approved, "Your lockout clears after 1 hour."),
    ("edit", TicketStatus.edited, "We will call you."),
    ("reject", TicketStatus.rejected, None),
])
def test_record_review_stores_the_decision(test_session, action, status, final_reply):
    result = saved()
    decision = ReviewDecision(
        action=action,
        edited_reply="We will call you." if action == "edit" else None,
        note="checked",
    )

    record = review(test_session, result.ticket_id, decision, final_reply)

    assert record.ticket_id == result.ticket_id
    assert record.status == status
    assert record.final_reply == final_reply
    assert record.review_note == "checked"
    assert record.reviewed_at is not None
    assert record.reference == result.reference
    # and it is really in the database
    again = store.get_ticket(result.ticket_id)
    assert (again.status, again.final_reply, again.review_note) == (status, final_reply, "checked")
    assert again.reviewed_at == record.reviewed_at


def test_record_review_leaves_the_original_suggestion_alone(test_session):
    result = saved()

    record = review(test_session, result.ticket_id, ReviewDecision(action="reject"), None)

    assert record.suggested_reply == "Your lockout clears after 1 hour."
    assert record.needs_human_review is True
    assert record.review_reason == "Needs a look."


def test_record_review_moves_updated_at_forward(test_session):
    result = saved()
    before = raw_row(test_session, result.ticket_id).updated_at

    review(test_session, result.ticket_id, ReviewDecision(action="approve"), "x")

    assert raw_row(test_session, result.ticket_id).updated_at > before


def test_a_second_review_of_the_same_ticket_returns_none_and_changes_nothing(test_session):
    result = saved()
    first = review(test_session, result.ticket_id, ReviewDecision(action="approve", note="one"), "A")

    second = review(test_session, result.ticket_id, ReviewDecision(action="reject", note="two"), None)

    assert second is None
    now = store.get_ticket(result.ticket_id)
    assert (now.status, now.final_reply, now.review_note) == (TicketStatus.approved, "A", "one")
    assert now.reviewed_at == first.reviewed_at


def test_an_unknown_ticket_id_returns_none(test_session):
    assert review(test_session, str(uuid4()), ReviewDecision(action="approve"), "x") is None


def test_a_ticket_that_is_not_pending_review_is_unchanged(test_session):
    result = saved(needs_human_review=False)  # stored as triaged
    before = raw_row(test_session, result.ticket_id)

    outcome = review(test_session, result.ticket_id, ReviewDecision(action="approve"), "x")

    after = raw_row(test_session, result.ticket_id)
    assert outcome is None
    assert after.status == "triaged"
    assert (after.final_reply, after.review_note, after.reviewed_at) == (None, None, None)
    assert after.updated_at == before.updated_at


def test_a_malformed_ticket_id_is_rejected_before_any_database_work(test_session):
    with pytest.raises(ValueError):
        review(test_session, "not-a-uuid", ReviewDecision(action="approve"), "x")


def test_the_caller_owns_the_transaction(test_session):
    result = saved()

    with pytest.raises(RuntimeError):
        with test_session.begin() as session:
            store.record_review(session, result.ticket_id, ReviewDecision(action="approve"), "x")
            raise RuntimeError("something later failed")

    assert store.get_ticket(result.ticket_id).status == TicketStatus.pending_review


# --- get_ticket_by_reference ------------------------------------------------

def test_a_ticket_can_be_found_by_its_reference(test_session):
    result = saved()

    record = store.get_ticket_by_reference(result.reference)

    assert record.ticket_id == result.ticket_id
    assert record.reference == result.reference


def test_an_unknown_reference_returns_none(test_session):
    saved()

    assert store.get_ticket_by_reference("TKT-NOPE22") is None


# --- reference collisions ---------------------------------------------------

def test_a_reference_collision_is_retried_and_the_stored_reference_is_returned(
    test_session, monkeypatch
):
    taken = saved()
    fresh = make_result(reference=taken.reference)  # the same reference again
    monkeypatch.setattr(store, "new_reference", lambda: "TKT-RETRY2")

    stored = store.save_ticket(TICKET_IN, fresh)

    assert stored == "TKT-RETRY2"
    assert store.get_ticket(fresh.ticket_id).reference == "TKT-RETRY2"
    assert store.get_ticket(taken.ticket_id).reference == taken.reference


def test_no_collision_returns_the_reference_it_was_given(test_session):
    result = make_result()

    assert store.save_ticket(TICKET_IN, result) == result.reference


def test_it_keeps_trying_until_a_free_reference_turns_up(test_session, monkeypatch):
    taken = saved()
    draws = iter([taken.reference, taken.reference, "TKT-FREE22"])
    monkeypatch.setattr(store, "new_reference", lambda: next(draws))

    stored = store.save_ticket(TICKET_IN, make_result(reference=taken.reference))

    assert stored == "TKT-FREE22"


def test_it_gives_up_after_three_retries(test_session, monkeypatch):
    taken = saved()
    draws = []

    def always_taken():
        draws.append(1)
        return taken.reference

    monkeypatch.setattr(store, "new_reference", always_taken)
    doomed = make_result(reference=taken.reference)

    with pytest.raises(IntegrityError, match="tickets_reference_key"):
        store.save_ticket(TICKET_IN, doomed)

    assert len(draws) == 3  # the first attempt plus three retries
    assert store.get_ticket(doomed.ticket_id) is None


def test_a_duplicate_id_is_not_retried(test_session, monkeypatch):
    first = saved()
    draws = []
    monkeypatch.setattr(store, "new_reference", lambda: draws.append(1) or "TKT-NEVER2")
    same_id = make_result(ticket_id=first.ticket_id)  # different reference, same id

    with pytest.raises(IntegrityError, match="tickets_pkey"):
        store.save_ticket(TICKET_IN, same_id)

    assert draws == []


# --- through the API --------------------------------------------------------

class FakeChain:
    def __init__(self, result):
        self.result = result

    def invoke(self, inputs):
        return self.result


@pytest.fixture
def client(monkeypatch, test_session):
    monkeypatch.setattr(classifier, "_chain", FakeChain(ClassificationResult(
        category=Category.account, urgency=Urgency.high, confidence=0.95, reasoning="Locked.",
    )))
    monkeypatch.setattr(reply_draft, "_chain", FakeChain(ai_message("Your lockout clears.")))
    monkeypatch.setattr(critic, "_chain", FakeChain(CritiqueResult(needs_human_review=True, reason="Look.")))
    monkeypatch.setattr(
        kb_retrieval, "search_similar",
        lambda query_text, top_k: [KbMatch(topic="t", content="c", distance=0.3)],
    )
    return TestClient(app)


TICKET = {"subject": "Cannot log in", "body": "Account locked."}


def test_the_triage_response_reference_is_the_stored_reference(client):
    posted = client.post("/triage", json=TICKET).json()

    stored = store.get_ticket(posted["ticket_id"])

    assert posted["reference"].startswith("TKT-") and len(posted["reference"]) == 10
    assert stored.reference == posted["reference"]
    assert store.get_ticket_by_reference(posted["reference"]).ticket_id == posted["ticket_id"]


def test_the_response_matches_the_row_even_after_a_collision(client, test_session, monkeypatch):
    first = client.post("/triage", json=TICKET).json()
    from app.api import triage as triage_api
    monkeypatch.setattr(triage_api, "new_reference", lambda: first["reference"])
    monkeypatch.setattr(store, "new_reference", lambda: "TKT-SECOND2")

    second = client.post("/triage", json=TICKET).json()

    assert second["reference"] == "TKT-SECOND2"
    assert store.get_ticket(second["ticket_id"]).reference == "TKT-SECOND2"
    assert store.get_ticket(first["ticket_id"]).reference == first["reference"]


def test_get_ticket_returns_the_new_fields_before_and_after_a_review(client, test_session):
    posted = client.post("/triage", json=TICKET).json()

    before = client.get(f"/tickets/{posted['ticket_id']}").json()
    assert before["reference"] == posted["reference"]
    assert (before["final_reply"], before["review_note"], before["reviewed_at"]) == (None, None, None)

    review(test_session, posted["ticket_id"], ReviewDecision(action="approve", note="fine"), "Your lockout clears.")
    after = client.get(f"/tickets/{posted['ticket_id']}").json()

    assert after["status"] == "approved"
    assert after["final_reply"] == "Your lockout clears."
    assert after["review_note"] == "fine"
    assert after["reviewed_at"] is not None


@pytest.mark.parametrize("action,status", [
    ("approve", "approved"), ("edit", "edited"), ("reject", "rejected"),
])
def test_the_status_filter_finds_reviewed_tickets(client, test_session, action, status):
    posted = client.post("/triage", json=TICKET).json()
    other = client.post("/triage", json=TICKET).json()
    decision = ReviewDecision(action=action, edited_reply="E" if action == "edit" else None)
    review(test_session, posted["ticket_id"], decision, "x")

    listed = client.get("/tickets", params={"status": status})

    assert listed.status_code == 200
    assert [t["ticket_id"] for t in listed.json()] == [posted["ticket_id"]]
    pending = client.get("/tickets", params={"status": "pending_review"}).json()
    assert [t["ticket_id"] for t in pending] == [other["ticket_id"]]
