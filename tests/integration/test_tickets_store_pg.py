from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest
from sqlalchemy.exc import IntegrityError

from app.models import (
    Category,
    KbMatch,
    TicketIn,
    TicketStatus,
    TriageResult,
    Urgency,
)
from app.tickets import store
from app.tickets.orm import TicketRow

pytestmark = pytest.mark.integration


def make_result(ticket_id=None, needs_human_review=False, kb_sources=None) -> TriageResult:
    return TriageResult(
        ticket_id=ticket_id or str(uuid4()),
        category=Category.account,
        urgency=Urgency.high,
        confidence=0.95,
        routing_target="account-management-urgent",
        suggested_reply="Your lockout clears after 1 hour.",
        kb_sources=kb_sources or [],
        needs_human_review=needs_human_review,
        review_reason="Needs a look." if needs_human_review else None,
    )


def test_a_saved_ticket_reads_back_with_every_field(test_session):
    matches = [KbMatch(topic="account lockout", content="Clears after 1 hour.", distance=0.33)]
    result = make_result(kb_sources=matches)

    store.save_ticket(
        TicketIn(subject="Cannot log in", body="Account locked.", customer_id="cust-1"),
        result,
    )
    record = store.get_ticket(result.ticket_id)

    assert record.ticket_id == result.ticket_id
    assert record.status == TicketStatus.triaged
    assert (record.subject, record.body, record.customer_id) == (
        "Cannot log in", "Account locked.", "cust-1",
    )
    assert record.category == Category.account
    assert record.urgency == Urgency.high
    assert record.confidence == 0.95
    assert record.routing_target == "account-management-urgent"
    assert record.suggested_reply == "Your lockout clears after 1 hour."
    assert record.kb_sources == matches
    assert record.needs_human_review is False
    assert record.review_reason is None


def test_the_database_fills_in_the_created_at_timestamp(test_session):
    result = make_result()
    before = datetime.now(timezone.utc) - timedelta(seconds=5)

    store.save_ticket(TicketIn(subject="s", body="b"), result)
    record = store.get_ticket(result.ticket_id)

    assert record.created_at.tzinfo is not None
    assert before <= record.created_at <= datetime.now(timezone.utc) + timedelta(seconds=5)


def test_a_flagged_ticket_is_stored_as_pending_review(test_session):
    result = make_result(needs_human_review=True)

    store.save_ticket(TicketIn(subject="s", body="b"), result)
    record = store.get_ticket(result.ticket_id)

    assert record.status == TicketStatus.pending_review
    assert record.needs_human_review is True
    assert record.review_reason == "Needs a look."


def test_a_ticket_without_a_reply_or_sources_reads_back_empty(test_session):
    result = make_result().model_copy(update={"suggested_reply": None})

    store.save_ticket(TicketIn(subject="s", body="b"), result)
    record = store.get_ticket(result.ticket_id)

    assert record.suggested_reply is None
    assert record.kb_sources == []
    assert record.customer_id is None


def test_an_unknown_ticket_id_returns_none(test_session):
    assert store.get_ticket(str(uuid4())) is None


def test_saving_the_same_ticket_id_twice_is_rejected(test_session):
    result = make_result()
    store.save_ticket(TicketIn(subject="s", body="b"), result)

    with pytest.raises(IntegrityError):
        store.save_ticket(TicketIn(subject="s", body="b"), result)


def test_a_failed_save_leaves_no_row(test_session):
    result = make_result()
    store.save_ticket(TicketIn(subject="s", body="b"), result)

    with pytest.raises(IntegrityError):
        store.save_ticket(TicketIn(subject="again", body="b"), result)

    assert store.get_ticket(result.ticket_id).subject == "s"


def test_sql_looking_text_is_stored_verbatim(test_session):
    nasty = "Robert'); DROP TABLE tickets;--"
    result = make_result()

    store.save_ticket(TicketIn(subject=nasty, body="it's \"quoted\""), result)
    record = store.get_ticket(result.ticket_id)

    assert record.subject == nasty
    assert record.body == 'it\'s "quoted"'
    assert len(store.list_tickets()) == 1  # the table still exists and has the row


# --- list_tickets -----------------------------------------------------------

def _insert_with_created_at(test_session, created_at, status="triaged"):
    ticket_id = uuid4()
    with test_session.begin() as session:
        session.add(
            TicketRow(
                id=ticket_id, status=status, subject="s", body="b",
                category="account", urgency="low", confidence=0.9,
                routing_target="general-queue", kb_sources=[],
                needs_human_review=status == "pending_review",
                created_at=created_at,
            )
        )
    return str(ticket_id)


def test_list_returns_newest_first(test_session):
    now = datetime.now(timezone.utc)
    oldest = _insert_with_created_at(test_session, now - timedelta(hours=2))
    newest = _insert_with_created_at(test_session, now)
    middle = _insert_with_created_at(test_session, now - timedelta(hours=1))

    assert [t.ticket_id for t in store.list_tickets()] == [newest, middle, oldest]


def test_list_filters_by_status(test_session):
    now = datetime.now(timezone.utc)
    triaged = _insert_with_created_at(test_session, now, status="triaged")
    pending = _insert_with_created_at(test_session, now, status="pending_review")

    assert [t.ticket_id for t in store.list_tickets(status=TicketStatus.pending_review)] == [pending]
    assert [t.ticket_id for t in store.list_tickets(status=TicketStatus.triaged)] == [triaged]


def test_list_without_a_status_returns_every_status(test_session):
    now = datetime.now(timezone.utc)
    _insert_with_created_at(test_session, now, status="triaged")
    _insert_with_created_at(test_session, now, status="pending_review")

    assert len(store.list_tickets()) == 2


def test_list_respects_the_limit(test_session):
    now = datetime.now(timezone.utc)
    ids = [
        _insert_with_created_at(test_session, now - timedelta(minutes=i)) for i in range(5)
    ]

    listed = store.list_tickets(limit=2)

    assert [t.ticket_id for t in listed] == ids[:2]


def test_list_on_an_empty_table_returns_an_empty_list(test_session):
    assert store.list_tickets() == []


def test_the_ticket_id_round_trips_as_a_uuid_string(test_session):
    result = make_result()

    store.save_ticket(TicketIn(subject="s", body="b"), result)

    assert UUID(store.get_ticket(result.ticket_id).ticket_id) == UUID(result.ticket_id)
