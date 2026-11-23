"""One-click approval of an auto-handled (triaged) ticket, and the reviewed_since filter, on a real Postgres.

A triaged ticket's graph run is finished, so approving it must NOT touch the graph: the graph given to the app here
raises if anything calls it.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.api.deps import get_graph
from app.config import settings
from app.main import app
from app.models import Category, TicketIn, TriageResult, Urgency
from app.tickets import store
from app.tickets.reference import new_reference

pytestmark = pytest.mark.integration
KEY = "dummy-review-key"
HEADERS = {"X-API-Key": KEY}
REVIEWER = {"id": "user:3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34", "name": "Ọbiọma Ụzọ"}
DRAFT = "Your lockout clears after 1 hour."


class GraphMustNotBeUsed:
    def __getattr__(self, name):
        raise AssertionError(f"the graph was touched ({name}): a triaged ticket has no paused run")


@pytest.fixture
def client(monkeypatch, test_session):
    monkeypatch.setattr(settings, "review_api_key", KEY)
    app.dependency_overrides[get_graph] = lambda: GraphMustNotBeUsed()
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.pop(get_graph, None)


def add(draft=DRAFT, status="triaged", email="ada@example.com"):
    ticket_id = str(uuid.uuid4())
    result = TriageResult(
        ticket_id=ticket_id, reference=new_reference(), category=Category.account, urgency=Urgency.low,
        confidence=0.95, routing_target="q", needs_human_review=False, suggested_reply=draft,
    )
    store.save_ticket(TicketIn(subject="s", body="b", customer_email=email, customer_name="Ada"), result)
    if status != "triaged":
        # (a ticket that went through the graph and a reviewer is pending_review/approved...: the status is set directly)
        from app.db import get_session
        with get_session() as session:
            session.execute(text("UPDATE tickets SET status = :s WHERE id = :i"), {"s": status, "i": ticket_id})
    return ticket_id


def review(client, ticket_id, body=None):
    return client.post(f"/tickets/{ticket_id}/review", json={"action": "approve", "reviewer": REVIEWER, **(body or {})}, headers=HEADERS)


def test_approving_a_triaged_ticket_uses_its_draft_and_records_who_without_touching_the_graph(client):
    ticket_id = add()
    response = review(client, ticket_id, {"note": "looks right"})

    assert response.status_code == 200
    ticket = response.json()
    assert ticket["status"] == "approved" and ticket["final_reply"] == DRAFT
    assert ticket["review_note"] == "looks right"
    assert ticket["reviewed_by"] == REVIEWER and ticket["reviewed_at"] is not None
    assert client.get(f"/tickets/{ticket_id}").json()["status"] == "approved"


def test_a_second_approval_is_409_and_keeps_the_first_reviewer(client):
    ticket_id = add()
    assert review(client, ticket_id).status_code == 200
    again = review(client, ticket_id, {"note": "x"})  # the same reviewer id: even a repeat is refused
    assert again.status_code == 409
    assert client.get(f"/tickets/{ticket_id}").json()["review_note"] is None  # not overwritten


def test_a_triaged_ticket_with_no_draft_is_409(client):
    ticket_id = add(draft=None)
    assert review(client, ticket_id).status_code == 409
    assert client.get(f"/tickets/{ticket_id}").json()["status"] == "triaged"


@pytest.mark.parametrize("action,extra", [("edit", {"edited_reply": "mine"}), ("reject", {})])
def test_only_approve_is_allowed_on_a_triaged_ticket(client, action, extra):
    ticket_id = add()
    response = client.post(f"/tickets/{ticket_id}/review", json={"action": action, "reviewer": REVIEWER, **extra}, headers=HEADERS)
    assert response.status_code == 409
    assert client.get(f"/tickets/{ticket_id}").json()["status"] == "triaged"


def test_an_already_reviewed_ticket_is_still_409(client):
    assert review(client, add(status="rejected")).status_code == 409
    assert review(client, add(status="approved")).status_code == 409


def test_a_triaged_approval_still_needs_the_review_key_and_a_reviewer(client):
    ticket_id = add()
    assert client.post(f"/tickets/{ticket_id}/review", json={"action": "approve", "reviewer": REVIEWER}).status_code == 401
    assert client.post(f"/tickets/{ticket_id}/review", json={"action": "approve"}, headers=HEADERS).status_code == 422


def test_reviewed_since_returns_only_tickets_decided_since_then(client, test_session):
    old, recent = add(), add()
    review(client, old)
    review(client, recent)
    with test_session.begin() as s:
        s.execute(text("UPDATE tickets SET reviewed_at = :t WHERE id = :i"), {"t": datetime.now(timezone.utc) - timedelta(days=10), "i": old})
    since = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    found = client.get("/tickets", params={"status": "approved", "reviewed_since": since}).json()
    assert [t["ticket_id"] for t in found] == [recent]
    assert len(client.get("/tickets", params={"status": "approved"}).json()) == 2  # without the filter both


def test_a_bad_reviewed_since_is_422(client):
    assert client.get("/tickets", params={"reviewed_since": "yesterday"}).status_code == 422
