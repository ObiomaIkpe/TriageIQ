"""Cost per ticket on a real Postgres: migration 0005, saving the usage with the ticket, reading it back."""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.pool import NullPool

from app import usage
from app.api.deps import get_graph
from app.config import settings
from app.db import sqlalchemy_url
from app.graph import classifier, critic, kb_retrieval, reply_draft
from app.graph.build import build_triage_graph
from app.graph.checkpointer import create_checkpointer
from app.graph.critic import CritiqueResult
from app.main import app
from app.migrations import run_migrations
from app.models import Category, ClassificationResult, KbMatch, Urgency
from app.tools import cost_report
from tests.helpers import ai_message
from tests.integration.conftest import alembic_config
from alembic import command

pytestmark = pytest.mark.integration


class SpendingChain:
    """Stands in for a chain: returns a result and, like the real callback, records token usage."""

    def __init__(self, result, tokens_in, tokens_out):
        self.result, self.tokens = result, (tokens_in, tokens_out)

    def invoke(self, inputs):
        collector = usage.current()
        if collector is not None:
            collector.add("anthropic", "claude-sonnet-4-6", *self.tokens)
        return self.result


@pytest.fixture
def client(monkeypatch, test_session, migrated_database):
    monkeypatch.setattr(settings, "review_api_key", "k")
    checkpointer = create_checkpointer(migrated_database)
    app.dependency_overrides[get_graph] = lambda: build_triage_graph(checkpointer.saver)
    ok = ClassificationResult(category=Category.account, urgency=Urgency.high, confidence=0.95, reasoning="r")
    monkeypatch.setattr(classifier, "_chain", SpendingChain(ok, 1000, 100))
    monkeypatch.setattr(reply_draft, "_chain", SpendingChain(ai_message("Reply."), 2000, 400))
    monkeypatch.setattr(critic, "_chain", SpendingChain(CritiqueResult(needs_human_review=False, reason=""), 1500, 50))
    monkeypatch.setattr(kb_retrieval, "search_similar", lambda q, top_k: [KbMatch(topic="t", content="c", distance=0.3)])
    # the KB search is faked, so a Voyage call is simulated here
    real = kb_retrieval.search_similar
    monkeypatch.setattr(kb_retrieval, "search_similar", lambda q, top_k: (usage.record_embedding("voyage-3", 60), real(q, top_k))[1])
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.pop(get_graph, None)
    checkpointer.close()


def test_the_migration_adds_two_nullable_columns_and_downgrades(clean_database):
    run_migrations(clean_database)
    engine = create_engine(sqlalchemy_url(clean_database), poolclass=NullPool)
    columns = {c["name"]: c for c in inspect(engine).get_columns("tickets")}
    assert columns["ai_usage"]["nullable"] and columns["ai_cost_usd"]["nullable"]

    command.downgrade(alembic_config(clean_database), "0004")
    assert "ai_usage" not in {c["name"] for c in inspect(engine).get_columns("tickets")}
    run_migrations(clean_database)  # and up again


def test_a_triaged_ticket_stores_its_usage_and_cost_and_returns_them(client):
    created = client.post("/triage", json={"subject": "s", "body": "b"})
    assert created.status_code == 200
    ticket_id = created.json()["ticket_id"]
    assert "ai_usage" not in created.json() and "ai_cost_usd" not in created.json()  # not in the submitter's answer

    ticket = client.get(f"/tickets/{ticket_id}").json()
    expected = (4500 * 3 + 550 * 15) / 1e6 + 60 * 0.06 / 1e6
    assert ticket["ai_cost_usd"] == pytest.approx(expected, abs=1e-6)
    assert ticket["ai_usage"]["estimate"] is True
    assert ticket["ai_usage"]["providers"]["anthropic"] == {"calls": 3, "total_tokens": 5050}
    assert ticket["ai_usage"]["providers"]["voyage"] == {"calls": 1, "total_tokens": 60}
    assert ticket["ai_usage"]["total_tokens"] == 5110


def test_the_listing_and_the_report_see_the_cost(client):
    for index in range(3):
        client.post("/triage", json={"subject": f"s{index}", "body": "b"})
    listed = client.get("/tickets").json()
    assert all(t["ai_cost_usd"] is not None for t in listed)

    summary = cost_report.summarize(cost_report.fetch_rows(50))
    assert summary["tickets_with_cost"] == 3
    assert summary["max_usd"] == pytest.approx(summary["average_usd"])  # three identical tickets
    assert summary["total_tokens"] == 3 * 5110


def test_a_repeat_with_the_same_ticket_id_keeps_the_first_usage(client):
    body = {"subject": "s", "body": "b", "ticket_id": "3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34"}
    client.post("/triage", json=body)
    first = client.get(f"/tickets/{body['ticket_id']}").json()["ai_usage"]
    assert client.post("/triage", json=body).status_code == 200  # answered from the row: no model calls
    assert client.get(f"/tickets/{body['ticket_id']}").json()["ai_usage"] == first


def test_an_old_ticket_without_usage_reads_as_null(client, test_session):
    created = client.post("/triage", json={"subject": "s", "body": "b"}).json()
    with test_session() as session:
        session.execute(text("UPDATE tickets SET ai_usage = NULL, ai_cost_usd = NULL"))
        session.commit()
    ticket = client.get(f"/tickets/{created['ticket_id']}").json()
    assert ticket["ai_usage"] is None and ticket["ai_cost_usd"] is None
