from datetime import datetime, timezone

import psycopg
import pytest
import sqlalchemy.exc
from fastapi.testclient import TestClient

from app.api import tickets as tickets_api
from app.main import app
from app.models import (
    Category,
    KbMatch,
    TicketRecord,
    TicketStatus,
    Urgency,
)

client = TestClient(app)

TICKET_ID = "12345678-1234-5678-1234-567812345678"
CREATED_AT = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)


def make_record(**overrides) -> TicketRecord:
    values = dict(
        ticket_id=TICKET_ID,
        status=TicketStatus.triaged,
        subject="Cannot log in",
        body="Account locked.",
        customer_id=None,
        category=Category.account,
        urgency=Urgency.high,
        confidence=0.95,
        routing_target="account-management-urgent",
        suggested_reply="Your lockout clears after 1 hour.",
        kb_sources=[
            KbMatch(topic="account lockout", content="Clears after 1 hour.", distance=0.33)
        ],
        needs_human_review=False,
        review_reason=None,
        created_at=CREATED_AT,
    )
    values.update(overrides)
    return TicketRecord(**values)


# --- GET /tickets/{id} ------------------------------------------------------

def test_get_ticket_returns_the_record(monkeypatch):
    seen = []

    def fake_get(ticket_id):
        seen.append(ticket_id)
        return make_record()

    monkeypatch.setattr(tickets_api, "get_ticket", fake_get)

    response = client.get(f"/tickets/{TICKET_ID}")

    assert response.status_code == 200
    body = response.json()
    assert body["ticket_id"] == TICKET_ID
    assert body["status"] == "triaged"
    assert body["subject"] == "Cannot log in"
    assert body["kb_sources"] == [
        {"topic": "account lockout", "content": "Clears after 1 hour.", "distance": 0.33}
    ]
    assert seen == [TICKET_ID]
    assert isinstance(seen[0], str)


def test_get_ticket_returns_404_when_the_store_has_none(monkeypatch):
    monkeypatch.setattr(tickets_api, "get_ticket", lambda ticket_id: None)

    response = client.get(f"/tickets/{TICKET_ID}")

    assert response.status_code == 404
    assert response.json() == {"detail": "Ticket not found"}


def test_get_ticket_rejects_a_non_uuid_id_without_calling_the_store(monkeypatch):
    calls = []
    monkeypatch.setattr(tickets_api, "get_ticket", lambda ticket_id: calls.append(ticket_id))

    response = client.get("/tickets/not-a-uuid")

    assert response.status_code == 422
    assert calls == []


def test_get_ticket_returns_503_when_the_database_is_down(monkeypatch):
    def down(ticket_id):
        raise sqlalchemy.exc.OperationalError(
            "SELECT ...", {}, psycopg.OperationalError("connection refused")
        )

    monkeypatch.setattr(tickets_api, "get_ticket", down)

    response = client.get(f"/tickets/{TICKET_ID}")

    assert response.status_code == 503
    assert response.json() == {
        "detail": "Database temporarily unavailable. Please retry."
    }


# --- GET /tickets -----------------------------------------------------------

def test_list_tickets_passes_defaults_to_the_store(monkeypatch):
    seen = []

    def fake_list(status, limit):
        seen.append((status, limit))
        return [make_record()]

    monkeypatch.setattr(tickets_api, "list_tickets", fake_list)

    response = client.get("/tickets")

    assert response.status_code == 200
    assert [t["ticket_id"] for t in response.json()] == [TICKET_ID]
    assert seen == [(None, 50)]


def test_list_tickets_passes_status_and_limit_to_the_store(monkeypatch):
    seen = []

    def fake_list(status, limit):
        seen.append((status, limit))
        return []

    monkeypatch.setattr(tickets_api, "list_tickets", fake_list)

    response = client.get("/tickets", params={"status": "pending_review", "limit": 10})

    assert response.status_code == 200
    assert response.json() == []
    assert seen == [(TicketStatus.pending_review, 10)]


@pytest.mark.parametrize("params", [
    {"status": "not-a-status"},
    {"limit": 0},
    {"limit": 201},
])
def test_list_tickets_rejects_invalid_parameters_without_calling_the_store(
    monkeypatch, params
):
    calls = []
    monkeypatch.setattr(
        tickets_api, "list_tickets", lambda status, limit: calls.append((status, limit))
    )

    response = client.get("/tickets", params=params)

    assert response.status_code == 422
    assert calls == []


@pytest.mark.parametrize("limit", [1, 200])
def test_list_tickets_accepts_the_limit_boundaries(monkeypatch, limit):
    monkeypatch.setattr(tickets_api, "list_tickets", lambda status, limit: [])

    response = client.get("/tickets", params={"limit": limit})

    assert response.status_code == 200
