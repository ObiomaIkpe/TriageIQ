"""Ticket list filtering, keyset pagination and counts on a real Postgres (rows and ordering are real)."""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from app.main import app
from app.models import Category, TicketIn, TicketStatus, TriageResult, Urgency
from app.tickets import store
from app.tickets.reference import new_reference

pytestmark = pytest.mark.integration
client = TestClient(app)
T0 = datetime(2026, 11, 23, 10, 0, 0, tzinfo=timezone.utc)


def add(test_session, minutes_ago, status="pending_review", ticket_id=None):
    """One ticket, saved through the store, then given a known age and status."""
    ticket_id = ticket_id or str(uuid.uuid4())
    result = TriageResult(
        ticket_id=ticket_id, reference=new_reference(), category=Category.account, urgency=Urgency.low,
        confidence=0.9, routing_target="q", needs_human_review=status == "pending_review", review_reason="r",
    )
    store.save_ticket(TicketIn(subject=f"s{minutes_ago}", body="b"), result)
    with test_session.begin() as s:
        s.execute(text("UPDATE tickets SET created_at = :t, status = :st WHERE id = :id"),
                  {"t": T0 - timedelta(minutes=minutes_ago), "st": status, "id": ticket_id})
    return ticket_id


def cursor_of(item):
    return f"{item['created_at']}|{item['ticket_id']}"


def test_status_filter_and_newest_first(test_session):
    a, b, c = add(test_session, 3), add(test_session, 1), add(test_session, 2, "approved")
    pending = client.get("/tickets", params={"status": "pending_review"}).json()
    assert [t["ticket_id"] for t in pending] == [b, a]  # newest first, the approved one is left out
    assert [t["ticket_id"] for t in client.get("/tickets", params={"status": "approved"}).json()] == [c]
    assert len(client.get("/tickets").json()) == 3


def test_pages_by_cursor_cover_every_ticket_once_in_order(test_session):
    ids = [add(test_session, m) for m in range(10, 0, -1)]  # oldest created first
    expected = list(reversed(ids))
    seen, cursor = [], None
    while True:
        params = {"limit": 3, **({"cursor": cursor} if cursor else {})}
        page = client.get("/tickets", params=params).json()
        seen += [t["ticket_id"] for t in page]
        if len(page) < 3:
            break
        cursor = cursor_of(page[-1])
    assert seen == expected


def test_tickets_with_the_same_created_at_are_neither_skipped_nor_repeated(test_session):
    ids = [add(test_session, 5) for _ in range(5)]  # identical timestamps: the id breaks the tie
    first = client.get("/tickets", params={"limit": 2}).json()
    second = client.get("/tickets", params={"limit": 2, "cursor": cursor_of(first[-1])}).json()
    third = client.get("/tickets", params={"limit": 2, "cursor": cursor_of(second[-1])}).json()
    got = [t["ticket_id"] for t in first + second + third]
    assert sorted(got) == sorted(ids) and len(set(got)) == 5


def test_a_ticket_arriving_between_pages_does_not_shift_the_next_page(test_session):
    for m in range(6, 0, -1):
        add(test_session, m + 10)
    first = client.get("/tickets", params={"limit": 3}).json()
    add(test_session, 0)  # newer than everything: an offset would now repeat a ticket on page two
    second = client.get("/tickets", params={"limit": 3, "cursor": cursor_of(first[-1])}).json()
    assert not {t["ticket_id"] for t in first} & {t["ticket_id"] for t in second}
    assert len(second) == 3


def test_the_cursor_filter_combines_with_the_status_filter(test_session):
    add(test_session, 1, "approved")
    older = add(test_session, 5)
    newer = add(test_session, 2)
    page = client.get("/tickets", params={"status": "pending_review", "limit": 1}).json()
    assert page[0]["ticket_id"] == newer
    rest = client.get("/tickets", params={"status": "pending_review", "cursor": cursor_of(page[0])}).json()
    assert [t["ticket_id"] for t in rest] == [older]


def test_counts_include_every_status_with_zeros(test_session):
    assert client.get("/tickets/counts").json() == {s.value: 0 for s in TicketStatus}
    add(test_session, 1); add(test_session, 2); add(test_session, 3, "approved"); add(test_session, 4, "triaged")
    assert client.get("/tickets/counts").json() == {
        "triaged": 1, "pending_review": 2, "approved": 1, "edited": 0, "rejected": 0,
    }
