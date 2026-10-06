"""Real startup, real Postgres checkpointer, a request through the real graph.

Claude and the KB search are faked (no API keys, no Voyage). The migrations, the
checkpointer, the graph, the ticket save and the reads are all real.
"""
import psycopg
import pytest
from fastapi.testclient import TestClient

from app import main
from app.graph import classifier, critic, kb_retrieval, reply_draft
from app.graph.checkpointer import create_checkpointer
from app.graph.critic import CritiqueResult
from app.main import app
from app.migrations import run_migrations
from app.models import Category, ClassificationResult, KbMatch, Urgency

pytestmark = pytest.mark.integration

TICKET = {"subject": "Cannot log in", "body": "Account locked."}
KB_MATCH = KbMatch(topic="account lockout", content="Clears after 1 hour.", distance=0.33)


class FakeChain:
    def __init__(self, result):
        self.result = result

    def invoke(self, inputs):
        return self.result


@pytest.fixture
def live_client(migrated_database, test_session, monkeypatch):
    """The app with its real startup hook, pointed at the test database."""
    monkeypatch.setattr(
        classifier,
        "_chain",
        FakeChain(
            ClassificationResult(
                category=Category.account, urgency=Urgency.high,
                confidence=0.95, reasoning="Locked account.",
            )
        ),
    )
    monkeypatch.setattr(reply_draft, "_chain", FakeChain("Your lockout clears after 1 hour."))
    monkeypatch.setattr(
        critic, "_chain", FakeChain(CritiqueResult(needs_human_review=False, reason=""))
    )
    monkeypatch.setattr(kb_retrieval, "search_similar", lambda query_text, top_k: [KB_MATCH])

    # Real migrations and a real checkpointer, but on the test database.
    monkeypatch.setattr(main, "run_migrations", lambda: run_migrations(migrated_database))
    monkeypatch.setattr(main, "create_checkpointer", lambda: create_checkpointer(migrated_database))

    app.dependency_overrides.clear()  # use the real get_graph
    monkeypatch.setattr(app.state, "triage_graph", None, raising=False)
    with TestClient(app) as client:
        yield client


def _checkpoint_rows(database_url, thread_id):
    url = database_url.replace("postgresql+psycopg://", "postgresql://", 1)
    with psycopg.connect(url) as conn:
        return conn.execute(
            "SELECT count(*) FROM checkpoints WHERE thread_id = %s", (thread_id,)
        ).fetchone()[0]


def test_startup_builds_a_graph_with_a_postgres_saver(live_client):
    assert app.state.triage_graph is not None
    assert type(app.state.triage_graph.checkpointer).__name__ == "PostgresSaver"
    assert live_client.get("/ready").json() == {"status": "ready"}


def test_a_triage_request_writes_checkpoint_rows_under_its_ticket_id(
    live_client, migrated_database
):
    response = live_client.post("/triage", json=TICKET)

    assert response.status_code == 200
    ticket_id = response.json()["ticket_id"]
    assert _checkpoint_rows(migrated_database, ticket_id) >= 1


def test_the_saved_graph_state_can_be_read_back_by_ticket_id(live_client):
    ticket_id = live_client.post("/triage", json=TICKET).json()["ticket_id"]

    state = app.state.triage_graph.get_state({"configurable": {"thread_id": ticket_id}})

    assert state.values["ticket"].subject == "Cannot log in"
    assert state.values["routing_target"] == "account-management-urgent"
    assert state.values["draft_reply"] == "Your lockout clears after 1 hour."
    assert state.next == ()  # the run finished; nothing is paused


def test_the_response_and_the_saved_ticket_are_unchanged_by_checkpointing(live_client):
    posted = live_client.post("/triage", json=TICKET).json()

    assert posted["category"] == "account"
    assert posted["routing_target"] == "account-management-urgent"
    assert posted["kb_sources"] == [KB_MATCH.model_dump()]
    assert posted["needs_human_review"] is False
    fetched = live_client.get(f"/tickets/{posted['ticket_id']}").json()
    assert fetched["ticket_id"] == posted["ticket_id"]
    assert fetched["status"] == "triaged"


def test_two_requests_get_two_separate_threads(live_client, migrated_database):
    first = live_client.post("/triage", json=TICKET).json()["ticket_id"]
    second = live_client.post("/triage", json=TICKET).json()["ticket_id"]

    assert first != second
    assert _checkpoint_rows(migrated_database, first) >= 1
    assert _checkpoint_rows(migrated_database, second) >= 1


def test_shutdown_clears_the_graph(migrated_database, test_session, monkeypatch):
    monkeypatch.setattr(main, "run_migrations", lambda: run_migrations(migrated_database))
    monkeypatch.setattr(main, "create_checkpointer", lambda: create_checkpointer(migrated_database))
    app.dependency_overrides.clear()
    monkeypatch.setattr(app.state, "triage_graph", None, raising=False)

    with TestClient(app):
        assert app.state.triage_graph is not None

    assert app.state.triage_graph is None
