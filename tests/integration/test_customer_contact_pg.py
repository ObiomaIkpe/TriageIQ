"""Customer contact fields and a gateway-chosen reference, on a real Postgres.

Claude and the KB search are faked; rows, constraints, the migration and the checkpointer are real.
"""
import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.pool import NullPool

from app.api.deps import get_graph
from app.config import settings
from app.graph import classifier, critic, kb_retrieval, reply_draft
from app.graph.build import build_triage_graph
from app.graph.checkpointer import create_checkpointer
from app.graph.critic import CritiqueResult
from app.main import app
from app.migrations import run_migrations
from app.models import Category, ClassificationResult, KbMatch, Urgency
from tests.helpers import ai_message
from tests.integration.conftest import alembic_config

pytestmark = pytest.mark.integration

NAME = "Ọbiọma Ụzọ"
EMAIL = "customer@example.com"
TID = "3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34"
TID2 = "00000000-0000-4000-8000-000000000002"
REF = "TKT-ABC234"
PUBLIC = {"subject": "Cannot log in", "body": "Account locked.", "customer_id": "public-form",
          "customer_name": NAME, "customer_email": EMAIL, "ticket_id": TID, "reference": REF}
COLUMNS = {"customer_name", "customer_email"}


class Chain:
    def __init__(self, result):
        self.result, self.calls = result, []

    def invoke(self, inputs):
        self.calls.append(inputs)
        return self.result


def _engine(url):
    from app.db import sqlalchemy_url
    return create_engine(sqlalchemy_url(url), poolclass=NullPool)


def _columns(url):
    return {c["name"] for c in inspect(_engine(url)).get_columns("tickets")}


@pytest.fixture
def world(monkeypatch, test_session, migrated_database):
    monkeypatch.setattr(settings, "review_api_key", "k")
    checkpointer = create_checkpointer(migrated_database)
    graph = build_triage_graph(checkpointer.saver)
    app.dependency_overrides[get_graph] = lambda: graph
    w = type("W", (), {})()
    w.classify = Chain(ClassificationResult(category=Category.account, urgency=Urgency.high, confidence=0.95, reasoning="r"))
    w.draft, w.critic = Chain(ai_message("Reply.")), Chain(CritiqueResult(needs_human_review=False, reason=""))
    monkeypatch.setattr(classifier, "_chain", w.classify)
    monkeypatch.setattr(reply_draft, "_chain", w.draft)
    monkeypatch.setattr(critic, "_chain", w.critic)
    monkeypatch.setattr(kb_retrieval, "search_similar", lambda q, top_k: [KbMatch(topic="t", content="c", distance=0.3)])
    w.checkpointer = checkpointer
    w.client, w.graph, w.factory = TestClient(app, raise_server_exceptions=False), graph, test_session
    w.rows = lambda: _rows(test_session)
    yield w
    app.dependency_overrides.pop(get_graph, None)
    checkpointer.close()


def _rows(factory):
    with factory() as s:
        return s.execute(text("SELECT id::text, reference, customer_id, customer_name, customer_email FROM tickets ORDER BY reference")).all()


# --- migration 0004 ----------------------------------------------------------------------------------

def test_0004_adds_two_nullable_text_columns(clean_database):
    run_migrations(clean_database)
    with _engine(clean_database).connect() as conn:
        rows = conn.execute(text(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
            "WHERE table_name='tickets' AND column_name IN ('customer_name','customer_email') ORDER BY 1"
        )).all()
    assert rows == [("customer_email", "text", "YES"), ("customer_name", "text", "YES")]


def test_0004_is_idempotent_at_startup_and_when_the_version_table_is_lost(clean_database):
    run_migrations(clean_database)
    run_migrations(clean_database)
    with _engine(clean_database).begin() as conn:
        conn.execute(text("UPDATE alembic_version SET version_num = '0003'"))
    run_migrations(clean_database)  # runs 0004 again over existing columns
    with _engine(clean_database).connect() as conn:
        assert conn.execute(text("SELECT version_num FROM alembic_version")).scalars().all() == ["0005"]
    assert COLUMNS <= _columns(clean_database)


def test_0004_downgrade_then_upgrade_and_old_rows_stay_null(clean_database):
    command.upgrade(alembic_config(clean_database), "0003")
    with _engine(clean_database).begin() as conn:
        conn.execute(text(
            "INSERT INTO tickets (reference, status, subject, body, category, urgency, confidence, routing_target, needs_human_review) "
            "VALUES ('TKT-OLD234','triaged','s','b','account','low',0.9,'q',false)"
        ))
    command.upgrade(alembic_config(clean_database), "head")
    with _engine(clean_database).connect() as conn:
        assert conn.execute(text("SELECT customer_name, customer_email FROM tickets")).one() == (None, None)
    command.downgrade(alembic_config(clean_database), "0003")
    assert not COLUMNS & _columns(clean_database)
    command.upgrade(alembic_config(clean_database), "head")
    assert COLUMNS <= _columns(clean_database)


# --- the supplied reference ---------------------------------------------------------------------------

def test_a_supplied_reference_and_the_contact_fields_are_stored_and_returned(world):
    response = world.client.post("/triage", json=PUBLIC)

    assert response.status_code == 200 and response.json()["reference"] == REF
    assert world.rows() == [(TID, REF, "public-form", NAME, EMAIL)]  # Unicode survives


def test_a_reply_with_the_same_id_and_reference_is_idempotent(world):
    first = world.client.post("/triage", json=PUBLIC).json()
    calls = len(world.classify.calls)
    again = world.client.post("/triage", json=PUBLIC)

    assert again.status_code == 200 and again.json() == first
    assert len(world.classify.calls) == calls and len(world.rows()) == 1


def test_a_supplied_reference_that_belongs_to_a_different_ticket_is_409_with_its_code(world):
    assert world.client.post("/triage", json=PUBLIC).status_code == 200

    clash = world.client.post("/triage", json={**PUBLIC, "ticket_id": TID2})

    assert clash.status_code == 409
    assert clash.json()["detail"]["code"] == "reference_conflict"
    assert [r[0] for r in world.rows()] == [TID]  # the first ticket is untouched, the second was not saved


def test_without_a_reference_python_still_generates_one(world):
    body = {k: v for k, v in PUBLIC.items() if k != "reference"}

    response = world.client.post("/triage", json=body)

    assert response.status_code == 200 and response.json()["reference"].startswith("TKT-")
    assert response.json()["reference"] != REF


# --- reads and the graph --------------------------------------------------------------------------------

def test_reviewer_reads_return_the_contact_fields(world):
    world.client.post("/triage", json=PUBLIC)

    single = world.client.get(f"/tickets/{TID}").json()
    by_reference = world.client.get(f"/tickets/reference/{REF}").json()
    listed = world.client.get("/tickets").json()

    for record in (single, by_reference):
        assert record["customer_name"] == NAME and record["customer_email"] == EMAIL
    assert any(t["customer_email"] == EMAIL and t["customer_name"] == NAME for t in listed)


def test_an_api_ticket_reads_back_with_null_contact_fields(world):
    world.client.post("/triage", json={"subject": "s", "body": "b", "ticket_id": TID2})

    assert world.client.get(f"/tickets/{TID2}").json()["customer_email"] is None


def test_the_saved_graph_state_and_every_prompt_exclude_the_contact_fields(world):
    world.client.post("/triage", json=PUBLIC)

    seen = repr([world.classify.calls, world.draft.calls, world.critic.calls])
    assert EMAIL not in seen and NAME not in seen
    state = world.graph.get_state({"configurable": {"thread_id": TID}}).values
    assert state["ticket"].customer_email is None and state["ticket"].customer_name is None
    # nor in anything the checkpointer wrote to Postgres (checkpoints, blobs and writes)
    with world.checkpointer.pool.connection() as conn:
        dumped = ""
        for table in ("checkpoints", "checkpoint_blobs", "checkpoint_writes"):
            dumped += repr(conn.execute(f"SELECT * FROM {table}").fetchall())
    assert "customer@example.com" not in dumped and "Ọbiọma" not in dumped and "\\u1ecc" not in dumped
