"""GET /tickets cursor and GET /tickets/counts, with the store faked (no database)."""
from fastapi.testclient import TestClient

from app.api import tickets as tickets_api
from app.main import app
from app.models import TicketStatus

client = TestClient(app, raise_server_exceptions=False)
ID = "3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34"


def test_a_cursor_is_parsed_and_passed_to_the_store(monkeypatch):
    seen = []
    monkeypatch.setattr(tickets_api, "list_tickets", lambda status, limit, before, scope=None: seen.append((status, limit, before)) or [])

    response = client.get("/tickets", params={"status": "pending_review", "limit": 20, "cursor": f"2026-11-23T10:00:00.123456+00:00|{ID}"})

    assert response.status_code == 200
    status, limit, (created_at, ticket_id) = seen[0]
    assert (status, limit) == (TicketStatus.pending_review, 20)
    assert created_at.isoformat() == "2026-11-23T10:00:00.123456+00:00" and str(ticket_id) == ID


def test_a_cursor_with_a_Z_zone_is_accepted(monkeypatch):
    monkeypatch.setattr(tickets_api, "list_tickets", lambda status, limit, before, scope=None: [])
    assert client.get("/tickets", params={"cursor": f"2026-11-23T10:00:00Z|{ID}"}).status_code == 200


def test_a_malformed_cursor_is_422_and_the_store_is_not_called(monkeypatch):
    calls = []
    monkeypatch.setattr(tickets_api, "list_tickets", lambda **kw: calls.append(kw) or [])
    for bad in ["nonsense", "2026-11-23T10:00:00Z", f"not-a-date|{ID}", "2026-11-23T10:00:00Z|not-a-uuid", "|", "x" * 101]:
        assert client.get("/tickets", params={"cursor": bad}).status_code == 422, bad
    assert calls == []


def test_an_unknown_status_is_422(monkeypatch):
    monkeypatch.setattr(tickets_api, "list_tickets", lambda status, limit, scope=None: [])
    assert client.get("/tickets", params={"status": "bogus"}).status_code == 422


def test_counts_is_its_own_route_not_a_ticket_id(monkeypatch):
    monkeypatch.setattr(tickets_api, "count_tickets_by_status", lambda scope=None: {"triaged": 1, "pending_review": 2, "approved": 0, "edited": 0, "rejected": 0})
    response = client.get("/tickets/counts")
    assert response.status_code == 200  # not a 422 from "counts" being read as a UUID
    assert response.json()["pending_review"] == 2


def test_reviewed_since_is_parsed_and_passed_to_the_store(monkeypatch):
    seen = []
    monkeypatch.setattr(tickets_api, "list_tickets", lambda status, limit, reviewed_since, scope=None: seen.append(reviewed_since) or [])
    assert client.get("/tickets", params={"status": "approved", "reviewed_since": "2026-11-16T10:00:00Z"}).status_code == 200
    assert seen[0].isoformat() == "2026-11-16T10:00:00+00:00"
