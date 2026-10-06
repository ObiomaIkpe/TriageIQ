from datetime import datetime, timezone
from uuid import UUID

import pytest
from psycopg.types.json import Jsonb

from app.models import (
    Category,
    KbMatch,
    TicketIn,
    TicketRecord,
    TicketStatus,
    TriageResult,
    Urgency,
)
from app.tickets import store

TICKET_ID = "12345678-1234-5678-1234-567812345678"
CREATED_AT = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)


class FakeConn:
    """Stands in for a psycopg connection used as a context manager."""

    def __init__(self, rows=None):
        self.rows = rows or []
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        return self

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


@pytest.fixture
def conn(monkeypatch):
    c = FakeConn()
    monkeypatch.setattr(store, "get_connection", lambda: c)
    return c


def _normalised(sql):
    return " ".join(sql.split())


def make_result(needs_human_review=False, kb_sources=None) -> TriageResult:
    return TriageResult(
        ticket_id=TICKET_ID,
        category=Category.account,
        urgency=Urgency.high,
        confidence=0.95,
        routing_target="account-management-urgent",
        suggested_reply="Your lockout clears after 1 hour.",
        kb_sources=kb_sources or [],
        needs_human_review=needs_human_review,
        review_reason="Needs a look." if needs_human_review else None,
    )


def make_row(**overrides):
    values = dict(
        id=UUID(TICKET_ID),
        status="triaged",
        subject="Cannot log in",
        body="Account locked.",
        customer_id="cust-1",
        category="account",
        urgency="high",
        confidence=0.95,
        routing_target="account-management-urgent",
        suggested_reply="Your lockout clears after 1 hour.",
        kb_sources=[
            {"topic": "account lockout", "content": "Clears after 1 hour.", "distance": 0.33}
        ],
        needs_human_review=False,
        review_reason=None,
        created_at=CREATED_AT,
    )
    values.update(overrides)
    return tuple(values.values())


# --- init_ticket_schema -----------------------------------------------------

def test_init_ticket_schema_creates_the_table_then_the_index(conn):
    store.init_ticket_schema()

    statements = [_normalised(sql) for sql, _ in conn.executed]
    assert len(statements) == 2
    assert statements[0].startswith("CREATE TABLE IF NOT EXISTS tickets")
    assert statements[1] == (
        "CREATE INDEX IF NOT EXISTS tickets_status_created_idx "
        "ON tickets (status, created_at)"
    )


def test_init_ticket_schema_runs_the_same_statements_every_time(conn):
    store.init_ticket_schema()
    store.init_ticket_schema()

    assert len(conn.executed) == 4
    assert conn.executed[:2] == conn.executed[2:]


# --- save_ticket ------------------------------------------------------------

def test_save_ticket_inserts_one_row_with_the_ticket_id_and_all_fields(conn):
    ticket = TicketIn(subject="Cannot log in", body="Account locked.", customer_id="cust-1")

    store.save_ticket(ticket, make_result())

    assert len(conn.executed) == 1
    sql, params = conn.executed[0]
    assert _normalised(sql).startswith("INSERT INTO tickets")
    assert params[:5] == (
        TICKET_ID, "triaged", "Cannot log in", "Account locked.", "cust-1",
    )
    assert params[5:9] == ("account", "high", 0.95, "account-management-urgent")
    assert params[9] == "Your lockout clears after 1 hour."
    assert params[11:] == (False, None)


def test_save_ticket_values_are_parameters_not_part_of_the_sql(conn):
    ticket = TicketIn(subject="Robert'); DROP TABLE tickets;--", body="b")

    store.save_ticket(ticket, make_result())

    sql, params = conn.executed[0]
    assert "DROP TABLE" not in sql
    assert ticket.subject in params


def test_flagged_result_is_saved_as_pending_review(conn):
    store.save_ticket(TicketIn(subject="s", body="b"), make_result(needs_human_review=True))

    _, params = conn.executed[0]
    assert params[1] == "pending_review"
    assert params[11:] == (True, "Needs a look.")


def test_unflagged_result_is_saved_as_triaged(conn):
    store.save_ticket(TicketIn(subject="s", body="b"), make_result(needs_human_review=False))

    _, params = conn.executed[0]
    assert params[1] == "triaged"


def test_kb_sources_are_saved_as_a_jsonb_list_of_dicts(conn):
    matches = [
        KbMatch(topic="account lockout", content="Clears after 1 hour.", distance=0.33),
        KbMatch(topic="password reset", content="Use the reset link.", distance=0.41),
    ]

    store.save_ticket(TicketIn(subject="s", body="b"), make_result(kb_sources=matches))

    kb_param = conn.executed[0][1][10]
    assert isinstance(kb_param, Jsonb)
    assert kb_param.obj == [
        {"topic": "account lockout", "content": "Clears after 1 hour.", "distance": 0.33},
        {"topic": "password reset", "content": "Use the reset link.", "distance": 0.41},
    ]


def test_no_kb_sources_are_saved_as_an_empty_jsonb_list(conn):
    store.save_ticket(TicketIn(subject="s", body="b"), make_result())

    kb_param = conn.executed[0][1][10]
    assert isinstance(kb_param, Jsonb)
    assert kb_param.obj == []


# --- get_ticket -------------------------------------------------------------

def test_get_ticket_returns_a_ticket_record_from_the_row(conn):
    conn.rows = [make_row()]

    record = store.get_ticket(TICKET_ID)

    assert isinstance(record, TicketRecord)
    assert record.ticket_id == TICKET_ID
    assert record.status == TicketStatus.triaged
    assert record.subject == "Cannot log in"
    assert record.customer_id == "cust-1"
    assert record.category == Category.account
    assert record.created_at == CREATED_AT
    assert record.kb_sources == [
        KbMatch(topic="account lockout", content="Clears after 1 hour.", distance=0.33)
    ]
    sql, params = conn.executed[0]
    assert "WHERE id = %s" in sql
    assert params == (TICKET_ID,)


def test_get_ticket_returns_none_when_there_is_no_row(conn):
    conn.rows = []

    assert store.get_ticket(TICKET_ID) is None


# --- list_tickets -----------------------------------------------------------

def test_list_tickets_without_a_status_has_no_where_clause(conn):
    conn.rows = [make_row()]

    records = store.list_tickets()

    assert [r.ticket_id for r in records] == [TICKET_ID]
    sql, params = conn.executed[0]
    assert "WHERE" not in sql
    assert "ORDER BY created_at DESC" in sql
    assert params == [50]


def test_list_tickets_with_a_status_adds_the_filter_and_passes_the_limit(conn):
    store.list_tickets(status=TicketStatus.pending_review, limit=10)

    sql, params = conn.executed[0]
    assert "WHERE status = %s" in sql
    assert "ORDER BY created_at DESC" in sql
    assert params == ["pending_review", 10]


def test_list_tickets_returns_an_empty_list_when_there_are_no_rows(conn):
    conn.rows = []

    assert store.list_tickets() == []


def test_list_tickets_maps_every_row(conn):
    conn.rows = [
        make_row(),
        make_row(id=UUID("87654321-4321-8765-4321-876543218765"), status="pending_review"),
    ]

    records = store.list_tickets()

    assert [r.status for r in records] == [TicketStatus.triaged, TicketStatus.pending_review]
