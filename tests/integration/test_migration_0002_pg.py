"""Migration 0002 on a real Postgres: backfilling references for existing tickets."""
import secrets

import pytest
from alembic import command
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.pool import NullPool

from app.tickets.reference import ALPHABET
from tests.integration.conftest import alembic_config

pytestmark = pytest.mark.integration

NEW_COLUMNS = {"reference", "final_reply", "review_note", "reviewed_at"}


def _engine(url):
    return create_engine(url, poolclass=NullPool)


def _columns(url):
    with _engine(url).connect() as conn:
        return {c["name"] for c in inspect(conn).get_columns("tickets")}


def _insert_old_tickets(url, count=3):
    """Insert tickets the way they exist at revision 0001 (no reference column)."""
    with _engine(url).begin() as conn:
        for n in range(count):
            conn.execute(
                text(
                    "INSERT INTO tickets (status, subject, body, category, urgency, "
                    "confidence, routing_target, needs_human_review) VALUES "
                    "(:status, :subject, 'b', 'account', 'low', 0.9, 'general-queue', false)"
                ),
                {"status": "triaged" if n % 2 else "pending_review", "subject": f"s{n}"},
            )


def _references(url):
    with _engine(url).connect() as conn:
        return conn.execute(text("SELECT reference FROM tickets ORDER BY subject")).scalars().all()


@pytest.fixture
def at_0001(clean_database):
    command.upgrade(alembic_config(clean_database), "0001")
    return clean_database


def test_0001_does_not_have_the_new_columns(at_0001):
    assert not NEW_COLUMNS & _columns(at_0001)


def test_upgrade_gives_every_existing_ticket_a_unique_reference(at_0001):
    _insert_old_tickets(at_0001, 3)

    command.upgrade(alembic_config(at_0001), "head")

    references = _references(at_0001)
    assert len(references) == 3
    assert all(r and r.startswith("TKT-") and len(r) == 10 for r in references)
    assert all(set(r[4:]) <= set(ALPHABET) for r in references)
    assert len(set(references)) == 3
    assert NEW_COLUMNS <= _columns(at_0001)


def test_existing_tickets_keep_their_data_and_have_no_review_yet(at_0001):
    _insert_old_tickets(at_0001, 3)

    command.upgrade(alembic_config(at_0001), "head")

    with _engine(at_0001).connect() as conn:
        rows = conn.execute(
            text("SELECT subject, status, final_reply, review_note, reviewed_at "
                 "FROM tickets ORDER BY subject")
        ).all()
    assert rows == [
        ("s0", "pending_review", None, None, None),
        ("s1", "triaged", None, None, None),
        ("s2", "pending_review", None, None, None),
    ]


def test_reference_is_not_null_and_unique_after_the_upgrade(at_0001):
    command.upgrade(alembic_config(at_0001), "head")

    with _engine(at_0001).connect() as conn:
        by_name = {c["name"]: c for c in inspect(conn).get_columns("tickets")}
        uniques = inspect(conn).get_unique_constraints("tickets")
    assert by_name["reference"]["nullable"] is False
    assert by_name["final_reply"]["nullable"] is True
    assert by_name["review_note"]["nullable"] is True
    assert by_name["reviewed_at"]["nullable"] is True
    assert {"name": "tickets_reference_key", "column_names": ["reference"]}.items() <= (
        next(u for u in uniques if u["name"] == "tickets_reference_key").items()
    )


def test_the_backfill_draws_again_when_it_makes_a_duplicate(at_0001, monkeypatch):
    _insert_old_tickets(at_0001, 3)
    real_choice = secrets.choice
    calls = {"n": 0}

    def choice(seq):
        # The first 12 characters are all "A", so the first two references are identical.
        calls["n"] += 1
        return "A" if calls["n"] <= 12 else real_choice(seq)

    monkeypatch.setattr(secrets, "choice", choice)

    command.upgrade(alembic_config(at_0001), "head")

    references = _references(at_0001)
    assert len(set(references)) == 3
    assert "TKT-AAAAAA" in references  # one kept the first draw, the other drew again


def test_upgrade_works_on_an_empty_tickets_table(at_0001):
    command.upgrade(alembic_config(at_0001), "head")

    assert _references(at_0001) == []


def test_downgrade_removes_the_new_columns_and_keeps_the_tickets(at_0001):
    _insert_old_tickets(at_0001, 3)
    command.upgrade(alembic_config(at_0001), "head")

    command.downgrade(alembic_config(at_0001), "0001")

    assert not NEW_COLUMNS & _columns(at_0001)
    with _engine(at_0001).connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM tickets")).scalar() == 3
        version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
        uniques = [u["name"] for u in inspect(conn).get_unique_constraints("tickets")]
    assert version == "0001"
    assert "tickets_reference_key" not in uniques


def test_upgrade_again_after_a_downgrade_backfills_again(at_0001):
    _insert_old_tickets(at_0001, 3)
    command.upgrade(alembic_config(at_0001), "head")
    command.downgrade(alembic_config(at_0001), "0001")

    command.upgrade(alembic_config(at_0001), "head")

    references = _references(at_0001)
    assert len(set(references)) == 3 and all(references)


def test_the_orm_still_matches_the_schema_after_a_round_trip(at_0001):
    command.upgrade(alembic_config(at_0001), "head")
    command.downgrade(alembic_config(at_0001), "0001")
    command.upgrade(alembic_config(at_0001), "head")

    command.check(alembic_config(at_0001))  # raises if autogenerate would change anything
