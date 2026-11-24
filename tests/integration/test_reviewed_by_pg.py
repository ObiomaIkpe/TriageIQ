"""reviewed_by on a real Postgres: the migration, the write, and the reads.

Claude and the KB search are faked; the database (rows, constraints, the migration) is real.
"""
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.pool import NullPool

from app.config import settings
from app.graph import classifier, critic, kb_retrieval, reply_draft
from app.graph.critic import CritiqueResult
from app.main import app
from app.migrations import run_migrations
from app.models import Category, ClassificationResult, KbMatch, ReviewDecision, Reviewer, TicketIn, TriageResult, Urgency
from app.tickets import store
from app.tickets.orm import TicketRow
from app.tickets.reference import new_reference
from tests.helpers import ai_message
from tests.integration.conftest import alembic_config

pytestmark = pytest.mark.integration

KEY = "dummy-review-key"
HEADERS = {"X-API-Key": KEY}
TICKET = {"subject": "Cannot log in", "body": "Account locked."}
USER_ID = "user:3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34"
UNICODE_NAME = "Ọbiọma Ụzọ"
COLUMNS = {"reviewed_by_id", "reviewed_by_name"}


class FakeChain:
    def __init__(self, result):
        self.result = result

    def invoke(self, inputs):
        return self.result


@pytest.fixture
def client(monkeypatch, test_session):
    monkeypatch.setattr(settings, "review_api_key", KEY)
    monkeypatch.setattr(
        classifier, "_chain",
        FakeChain(ClassificationResult(category=Category.other, urgency=Urgency.low, confidence=0.3, reasoning="Unclear.")),
    )
    monkeypatch.setattr(reply_draft, "_chain", FakeChain(ai_message("A reply.")))
    monkeypatch.setattr(critic, "_chain", FakeChain(CritiqueResult(needs_human_review=True, reason="Look.")))
    monkeypatch.setattr(kb_retrieval, "search_similar", lambda q, top_k: [KbMatch(topic="t", content="c", distance=0.3)])
    return TestClient(app)


def flagged(client):
    response = client.post("/triage", json=TICKET)
    assert response.status_code == 200, response.text
    assert response.json()["needs_human_review"] is True
    return response.json()["ticket_id"], response.json()["reference"]


def review(client, ticket_id, reviewer, action="edit", **extra):
    body = {"action": action, "reviewer": reviewer, **extra}
    if action == "edit":
        body.setdefault("edited_reply", "A human wrote this.")
    return client.post(f"/tickets/{ticket_id}/review", json=body, headers=HEADERS)


def raw(test_session, ticket_id):
    with test_session() as session:
        row = session.get(TicketRow, uuid.UUID(ticket_id))
        return row.reviewed_by_id, row.reviewed_by_name, row.status


def _engine(url):
    return create_engine(url, poolclass=NullPool)


def _columns(url):
    with _engine(url).connect() as conn:
        return {c["name"] for c in inspect(conn).get_columns("tickets")}


# --- the migration ------------------------------------------------------------------------

@pytest.fixture
def at_0002(clean_database):
    command.upgrade(alembic_config(clean_database), "0002")
    return clean_database


def _insert_reviewed_old_ticket(url):
    """A ticket reviewed before reviewers were recorded: reviewed_at set, no author."""
    with _engine(url).begin() as conn:
        conn.execute(text(
            "INSERT INTO tickets (reference, status, subject, body, category, urgency, confidence, routing_target, "
            "needs_human_review, final_reply, reviewed_at) VALUES "
            "('TKT-OLD234', 'approved', 's', 'b', 'account', 'low', 0.9, 'general-queue', true, 'x', now())"
        ))


def test_0002_has_no_reviewed_by_columns(at_0002):
    assert not COLUMNS & _columns(at_0002)


def test_upgrade_adds_both_columns_nullable(at_0002):
    command.upgrade(alembic_config(at_0002), "head")
    with _engine(at_0002).connect() as conn:
        rows = conn.execute(text(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
            "WHERE table_name = 'tickets' AND column_name LIKE 'reviewed_by_%' ORDER BY 1"
        )).all()
    assert rows == [("reviewed_by_id", "text", "YES"), ("reviewed_by_name", "text", "YES")]


def test_rows_reviewed_before_the_upgrade_keep_NULL_and_read_back_as_null(at_0002):
    _insert_reviewed_old_ticket(at_0002)
    command.upgrade(alembic_config(at_0002), "head")

    with _engine(at_0002).connect() as conn:
        assert conn.execute(text("SELECT reviewed_by_id, reviewed_by_name, status FROM tickets")).one() == (None, None, "approved")


def test_the_startup_migration_can_run_twice(clean_database):
    """The app runs `alembic upgrade head` at every start: the second run must change nothing."""
    run_migrations(clean_database)
    run_migrations(clean_database)
    with _engine(clean_database).connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalars().all() == ["0006"]
    assert COLUMNS <= _columns(clean_database)


def test_the_alter_statements_are_safe_to_repeat_even_if_the_version_table_was_lost(at_0002):
    """IF NOT EXISTS / IF EXISTS: re-applying 0003's and 0004's SQL over a database that already has the columns is fine."""
    command.upgrade(alembic_config(at_0002), "head")
    with _engine(at_0002).begin() as conn:
        conn.execute(text("UPDATE alembic_version SET version_num = '0002'"))
    command.upgrade(alembic_config(at_0002), "head")  # runs 0003 and 0004 again over the existing columns
    with _engine(at_0002).connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalars().all() == ["0006"]


def test_downgrade_then_upgrade_again(at_0002):
    command.upgrade(alembic_config(at_0002), "head")
    command.downgrade(alembic_config(at_0002), "0002")
    assert not COLUMNS & _columns(at_0002)
    command.upgrade(alembic_config(at_0002), "head")
    assert COLUMNS <= _columns(at_0002)


def test_the_database_keeps_the_pair_together(migrated_database):
    with _engine(migrated_database).begin() as conn:
        conn.execute(text(
            "INSERT INTO tickets (reference, status, subject, body, category, urgency, confidence, routing_target, needs_human_review) "
            "VALUES ('TKT-AAAAAA','pending_review','s','b','account','low',0.9,'q',true)"
        ))
    for one_sided in ("reviewed_by_id = 'client:ops'", "reviewed_by_name = 'ops'"):
        with pytest.raises(IntegrityError, match="tickets_reviewed_by_both_or_neither"):
            with _engine(migrated_database).begin() as conn:
                conn.execute(text(f"UPDATE tickets SET {one_sided}"))
    with _engine(migrated_database).begin() as conn:  # both, or neither, is fine
        conn.execute(text("UPDATE tickets SET reviewed_by_id = 'client:ops', reviewed_by_name = 'ops'"))
        conn.execute(text("UPDATE tickets SET reviewed_by_id = NULL, reviewed_by_name = NULL"))


# --- the write ----------------------------------------------------------------------------

def test_a_review_stores_the_id_and_the_name_with_the_decision(client, test_session):
    ticket_id, _ = flagged(client)

    response = review(client, ticket_id, {"id": USER_ID, "name": "Ada Lovelace"}, action="edit")

    assert response.status_code == 200
    assert raw(test_session, ticket_id) == (USER_ID, "Ada Lovelace", "edited")
    assert response.json()["reviewed_by"] == {"id": USER_ID, "name": "Ada Lovelace"}


def test_the_author_is_written_by_the_same_statement_as_the_decision(test_session):
    """record_review is ONE UPDATE: the status and the author appear together or not at all."""
    result = make_pending_result()
    store.save_ticket(TicketIn(subject="s", body="b"), result)
    with pytest.raises(RuntimeError):
        with test_session.begin() as session:
            updated = store.record_review(
                session, result.ticket_id, ReviewDecision(action="approve"), "x", Reviewer(id="client:ops", name="ops")
            )
            assert updated is not None and updated.reviewed_by is not None
            raise RuntimeError("something fails after the write, before the commit")
    assert raw(test_session, result.ticket_id) == (None, None, "pending_review")  # nothing of the review was kept


def make_pending_result():
    return TriageResult(
        ticket_id=str(uuid.uuid4()),
        reference=new_reference(),
        category=Category.account,
        urgency=Urgency.low,
        confidence=0.9,
        routing_target="q",
        needs_human_review=True,
        review_reason="r",
    )


def test_a_unicode_name_round_trips_through_postgres(client, test_session):
    ticket_id, reference = flagged(client)
    review(client, ticket_id, {"id": "client:ops", "name": f"  {UNICODE_NAME} "}).raise_for_status()

    assert raw(test_session, ticket_id)[1] == UNICODE_NAME  # trimmed, accents and dots intact
    assert client.get(f"/tickets/{ticket_id}").json()["reviewed_by"]["name"] == UNICODE_NAME
    assert client.get(f"/tickets/reference/{reference}").json()["reviewed_by"]["name"] == UNICODE_NAME


def test_the_name_is_a_snapshot_a_later_rename_does_not_change_old_reviews(client, test_session):
    first, _ = flagged(client)
    second, _ = flagged(client)
    review(client, first, {"id": USER_ID, "name": "Ada Lovelace"}).raise_for_status()
    review(client, second, {"id": USER_ID, "name": "Ada King"}).raise_for_status()  # renamed in between

    assert raw(test_session, first)[:2] == (USER_ID, "Ada Lovelace")
    assert raw(test_session, second)[:2] == (USER_ID, "Ada King")


def test_a_second_review_is_409_and_does_not_overwrite_the_first_reviewer(client, test_session):
    ticket_id, _ = flagged(client)
    review(client, ticket_id, {"id": USER_ID, "name": "Ada Lovelace"}, action="edit").raise_for_status()

    second = review(client, ticket_id, {"id": "client:ops", "name": "ops"}, action="reject")

    assert second.status_code == 409
    assert raw(test_session, ticket_id) == (USER_ID, "Ada Lovelace", "edited")


def test_two_simultaneous_reviews_one_wins_and_its_author_is_the_one_stored(client, test_session):
    ticket_id, _ = flagged(client)
    barrier = threading.Barrier(2)

    def post(reviewer):
        http = TestClient(app)
        barrier.wait()
        return reviewer["id"], review(http, ticket_id, reviewer).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = dict(pool.map(post, [{"id": "client:one", "name": "One"}, {"id": "client:two", "name": "Two"}]))

    winner = [rid for rid, code in outcomes.items() if code == 200]
    assert sorted(outcomes.values()) == [200, 409]
    stored_id, stored_name, _ = raw(test_session, ticket_id)
    assert [stored_id] == winner  # the stored author is the winner's, with the winner's name
    assert stored_name == {"client:one": "One", "client:two": "Two"}[stored_id]


def test_a_refused_review_stores_no_author(client, test_session):
    ticket_id, _ = flagged(client)
    refused = review(client, ticket_id, {"id": "client:ops", "name": "ops"}, action="approve")  # no draft: a low-confidence ticket
    assert refused.status_code == 422
    assert raw(test_session, ticket_id) == (None, None, "pending_review")


@pytest.mark.parametrize("reviewer", [None, {"id": "admin", "name": "x"}, {"id": "client:ops", "name": " "}])
def test_an_invalid_or_missing_reviewer_is_422_and_the_ticket_stays_pending(client, test_session, reviewer):
    ticket_id, _ = flagged(client)
    body = {"action": "reject"} if reviewer is None else {"action": "reject", "reviewer": reviewer}
    assert client.post(f"/tickets/{ticket_id}/review", json=body, headers=HEADERS).status_code == 422
    assert raw(test_session, ticket_id) == (None, None, "pending_review")


# --- the reads ----------------------------------------------------------------------------

def test_reviewed_by_is_on_single_reads_and_the_list_and_null_when_not_reviewed(client):
    reviewed, reviewed_ref = flagged(client)
    waiting, waiting_ref = flagged(client)
    review(client, reviewed, {"id": USER_ID, "name": UNICODE_NAME}, action="edit").raise_for_status()
    expected = {"id": USER_ID, "name": UNICODE_NAME}

    assert client.get(f"/tickets/{reviewed}").json()["reviewed_by"] == expected
    assert client.get(f"/tickets/reference/{reviewed_ref}").json()["reviewed_by"] == expected
    assert client.get(f"/tickets/{waiting}").json()["reviewed_by"] is None
    assert client.get(f"/tickets/reference/{waiting_ref}").json()["reviewed_by"] is None

    listing = {t["ticket_id"]: t for t in client.get("/tickets").json()}
    assert listing[reviewed]["reviewed_by"] == expected
    assert listing[waiting]["reviewed_by"] is None
    assert all("reviewed_by" in t for t in listing.values())


def test_a_ticket_reviewed_before_the_upgrade_reads_as_null(client, migrated_database):
    _insert_reviewed_old_ticket(migrated_database)
    body = client.get("/tickets/reference/TKT-OLD234").json()
    assert body["status"] == "approved"
    assert body["reviewed_by"] is None
    assert body["reviewed_at"] is not None  # it WAS reviewed; only the author is unknown
    assert any(t["reference"] == "TKT-OLD234" and t["reviewed_by"] is None for t in client.get("/tickets").json())
