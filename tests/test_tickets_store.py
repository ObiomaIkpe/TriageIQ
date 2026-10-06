from datetime import datetime, timezone
from uuid import UUID

import pytest
from sqlalchemy.dialects import postgresql

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
from app.tickets.orm import TicketRow

TICKET_ID = "12345678-1234-5678-1234-567812345678"
CREATED_AT = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)


class FakeConn:
    """Stands in for a psycopg connection used as a context manager."""

    def __init__(self):
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        return self


class FakeSession:
    """Records what the store asks of a SQLAlchemy session; no database."""

    def __init__(self, get_result=None, scalars_result=()):
        self.added = []
        self.get_calls = []
        self.queries = []
        self._get_result = get_result
        self._scalars_result = scalars_result

    def add(self, row):
        self.added.append(row)

    def get(self, model, key):
        self.get_calls.append((model, key))
        return self._get_result

    def scalars(self, query):
        self.queries.append(query)
        return iter(self._scalars_result)


@pytest.fixture
def session(monkeypatch):
    s = FakeSession()

    class FakeBegin:
        def __enter__(self):
            return s

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(store, "get_session", lambda: FakeBegin())
    return s


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


def make_row(**overrides) -> TicketRow:
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
    return TicketRow(**values)


# --- init_ticket_schema (still raw SQL until startup moves to Alembic) -------

def test_init_ticket_schema_creates_the_table_then_the_index(monkeypatch):
    conn = FakeConn()
    monkeypatch.setattr(store, "get_connection", lambda: conn)

    store.init_ticket_schema()

    statements = [_normalised(sql) for sql, _ in conn.executed]
    assert len(statements) == 2
    assert statements[0].startswith("CREATE TABLE IF NOT EXISTS tickets")
    assert statements[1] == (
        "CREATE INDEX IF NOT EXISTS tickets_status_created_idx "
        "ON tickets (status, created_at)"
    )


def test_init_ticket_schema_runs_the_same_statements_every_time(monkeypatch):
    conn = FakeConn()
    monkeypatch.setattr(store, "get_connection", lambda: conn)

    store.init_ticket_schema()
    store.init_ticket_schema()

    assert len(conn.executed) == 4
    assert conn.executed[:2] == conn.executed[2:]


# --- _to_row ----------------------------------------------------------------

def test_to_row_maps_the_ticket_and_result_fields():
    ticket = TicketIn(subject="Cannot log in", body="Account locked.", customer_id="cust-1")

    row = store._to_row(ticket, make_result())

    assert row.id == UUID(TICKET_ID)
    assert (row.subject, row.body, row.customer_id) == (
        "Cannot log in", "Account locked.", "cust-1",
    )
    assert (row.category, row.urgency, row.confidence) == ("account", "high", 0.95)
    assert row.routing_target == "account-management-urgent"
    assert row.suggested_reply == "Your lockout clears after 1 hour."
    assert (row.needs_human_review, row.review_reason) == (False, None)


def test_flagged_result_becomes_pending_review():
    row = store._to_row(TicketIn(subject="s", body="b"), make_result(needs_human_review=True))

    assert row.status == "pending_review"
    assert (row.needs_human_review, row.review_reason) == (True, "Needs a look.")


def test_unflagged_result_becomes_triaged():
    row = store._to_row(TicketIn(subject="s", body="b"), make_result(needs_human_review=False))

    assert row.status == "triaged"


def test_kb_sources_become_a_list_of_plain_dicts():
    matches = [
        KbMatch(topic="account lockout", content="Clears after 1 hour.", distance=0.33),
        KbMatch(topic="password reset", content="Use the reset link.", distance=0.41),
    ]

    row = store._to_row(TicketIn(subject="s", body="b"), make_result(kb_sources=matches))

    assert row.kb_sources == [
        {"topic": "account lockout", "content": "Clears after 1 hour.", "distance": 0.33},
        {"topic": "password reset", "content": "Use the reset link.", "distance": 0.41},
    ]


def test_no_kb_sources_become_an_empty_list():
    row = store._to_row(TicketIn(subject="s", body="b"), make_result())

    assert row.kb_sources == []


def test_a_malformed_ticket_id_is_rejected_before_any_database_work():
    result = make_result().model_copy(update={"ticket_id": "not-a-uuid"})

    with pytest.raises(ValueError):
        store._to_row(TicketIn(subject="s", body="b"), result)


# --- _to_record -------------------------------------------------------------

def test_to_record_maps_a_row_back_to_a_ticket_record():
    record = store._to_record(make_row())

    assert isinstance(record, TicketRecord)
    assert record.ticket_id == TICKET_ID
    assert record.status == TicketStatus.triaged
    assert record.category == Category.account
    assert record.urgency == Urgency.high
    assert record.customer_id == "cust-1"
    assert record.created_at == CREATED_AT
    assert record.kb_sources == [
        KbMatch(topic="account lockout", content="Clears after 1 hour.", distance=0.33)
    ]


def test_a_saved_result_survives_the_round_trip_through_a_row():
    matches = [KbMatch(topic="account lockout", content="Clears after 1 hour.", distance=0.33)]
    row = store._to_row(
        TicketIn(subject="s", body="b", customer_id="c"),
        make_result(needs_human_review=True, kb_sources=matches),
    )
    row.created_at = CREATED_AT  # the database fills this in on insert

    record = store._to_record(row)

    assert record.ticket_id == TICKET_ID
    assert record.status == TicketStatus.pending_review
    assert record.kb_sources == matches
    assert (record.subject, record.body, record.customer_id) == ("s", "b", "c")


# --- save_ticket / get_ticket / list_tickets (no database) ------------------

def test_save_ticket_adds_one_row_in_one_session(session):
    store.save_ticket(TicketIn(subject="s", body="b"), make_result())

    assert len(session.added) == 1
    assert isinstance(session.added[0], TicketRow)
    assert session.added[0].id == UUID(TICKET_ID)


def test_get_ticket_looks_the_row_up_by_primary_key(session):
    session._get_result = make_row()

    record = store.get_ticket(TICKET_ID)

    assert session.get_calls == [(TicketRow, UUID(TICKET_ID))]
    assert record.ticket_id == TICKET_ID


def test_get_ticket_returns_none_when_there_is_no_row(session):
    session._get_result = None

    assert store.get_ticket(TICKET_ID) is None


def _compiled(query):
    return query.compile(dialect=postgresql.dialect())


def test_list_tickets_without_a_status_has_no_where_clause(session):
    store.list_tickets()

    compiled = _compiled(session.queries[0])
    sql = _normalised(str(compiled))
    assert "WHERE" not in sql
    assert "ORDER BY tickets.created_at DESC" in sql
    assert 50 in compiled.params.values()


def test_list_tickets_with_a_status_adds_the_filter_and_passes_the_limit(session):
    store.list_tickets(status=TicketStatus.pending_review, limit=10)

    compiled = _compiled(session.queries[0])
    sql = _normalised(str(compiled))
    assert "WHERE tickets.status =" in sql
    assert "ORDER BY tickets.created_at DESC" in sql
    assert set(compiled.params.values()) == {"pending_review", 10}


def test_list_tickets_maps_every_row(session):
    session._scalars_result = [
        make_row(),
        make_row(id=UUID("87654321-4321-8765-4321-876543218765"), status="pending_review"),
    ]

    records = store.list_tickets()

    assert [r.status for r in records] == [TicketStatus.triaged, TicketStatus.pending_review]


def test_list_tickets_returns_an_empty_list_when_there_are_no_rows(session):
    assert store.list_tickets() == []
