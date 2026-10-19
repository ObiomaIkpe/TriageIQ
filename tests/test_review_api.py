"""POST /tickets/{id}/review and GET /tickets/reference/{reference} without a database."""
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from app.api import review as review_api
from app.config import settings
from app.main import app
from app.models import Category, TicketRecord, TicketStatus, Urgency

client = TestClient(app)

KEY = "dummy-review-key"
TICKET_ID = "12345678-1234-5678-1234-567812345678"
URL = f"/tickets/{TICKET_ID}/review"


@pytest.fixture
def key_set(monkeypatch):
    monkeypatch.setattr(settings, "review_api_key", KEY)


def record():
    return TicketRecord(
        ticket_id=TICKET_ID,
        reference="TKT-ABC234",
        status=TicketStatus.triaged,
        subject="s",
        body="b",
        category=Category.account,
        urgency=Urgency.low,
        confidence=0.9,
        routing_target="general-queue",
        needs_human_review=False,
        created_at=datetime(2026, 10, 19, tzinfo=timezone.utc),
    )


# --- the key is checked first ---------------------------------------------------

def test_no_key_is_401_before_the_body_is_even_validated(key_set):
    response = client.post(URL, json={"action": "nonsense"})

    assert response.status_code == 401


def test_no_key_is_401_even_for_a_malformed_ticket_id(key_set):
    assert client.post("/tickets/not-a-uuid/review", json={"action": "approve"}).status_code == 401


def test_a_wrong_key_is_401(key_set):
    response = client.post(URL, json={"action": "approve"}, headers={"X-API-Key": "nope"})

    assert response.status_code == 401


def test_a_disabled_endpoint_is_503_even_with_a_header(monkeypatch):
    monkeypatch.setattr(settings, "review_api_key", "")

    response = client.post(URL, json={"action": "approve"}, headers={"X-API-Key": "anything"})

    assert response.status_code == 503
    assert "REVIEW_API_KEY" in response.json()["detail"]


def test_the_key_is_checked_before_the_graph_is_asked_for(key_set):
    from app.api.deps import get_graph

    def boom():
        raise AssertionError("get_graph must not run before the key check")

    app.dependency_overrides[get_graph] = boom  # the autouse fixture removes it again
    response = client.post(URL, json={"action": "approve"})

    assert response.status_code == 401


# --- with a good key, validation still applies ---------------------------------

def test_a_malformed_ticket_id_is_422(key_set):
    response = client.post(
        "/tickets/not-a-uuid/review", json={"action": "approve"}, headers={"X-API-Key": KEY}
    )

    assert response.status_code == 422


@pytest.mark.parametrize("body", [
    {},
    {"action": "delete"},
    {"action": "edit"},
    {"action": "edit", "edited_reply": "   "},
])
def test_an_invalid_body_is_422_and_nothing_is_touched(key_set, monkeypatch, body):
    touched = []
    monkeypatch.setattr(review_api, "get_session", lambda: touched.append(1))

    response = client.post(URL, json=body, headers={"X-API-Key": KEY})

    assert response.status_code == 422
    assert touched == []


# --- GET /tickets/reference/{reference} ----------------------------------------

def test_a_ticket_is_found_by_reference(monkeypatch):
    seen = []
    monkeypatch.setattr(
        review_api, "get_ticket_by_reference", lambda ref: seen.append(ref) or record()
    )

    response = client.get("/tickets/reference/TKT-ABC234")

    assert response.status_code == 200
    assert response.json()["reference"] == "TKT-ABC234"
    assert seen == ["TKT-ABC234"]


def test_an_unknown_reference_is_404(monkeypatch):
    monkeypatch.setattr(review_api, "get_ticket_by_reference", lambda ref: None)

    response = client.get("/tickets/reference/TKT-NOPE22")

    assert response.status_code == 404
    assert response.json() == {"detail": "Ticket not found"}


def test_the_reference_route_is_not_captured_by_the_ticket_id_route(monkeypatch):
    # If /tickets/{ticket_id} captured it, "reference" would fail UUID parsing (422).
    monkeypatch.setattr(review_api, "get_ticket_by_reference", lambda ref: None)

    assert client.get("/tickets/reference/anything").status_code == 404


def test_the_ticket_id_route_still_works_and_rejects_a_non_uuid(monkeypatch):
    assert client.get("/tickets/reference").status_code == 422  # one segment: {ticket_id}
