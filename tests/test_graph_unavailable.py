"""What callers see while app.state.triage_graph is None.

The startup hook is not run here (TestClient is not used as a context manager),
so the app has no graph, exactly as it would if startup could not reach the
database.
"""
import pytest
from fastapi.testclient import TestClient

from app import main
from app.errors import RETRY_AFTER_SECONDS
from app.main import app

client = TestClient(app)
TICKET = {"subject": "Cannot log in", "body": "Account locked."}


@pytest.fixture(autouse=True)
def no_graph(monkeypatch):
    # Remove the override the autouse conftest fixture installed, so the real
    # get_graph dependency runs.
    app.dependency_overrides.clear()
    monkeypatch.setattr(app.state, "triage_graph", None, raising=False)
    monkeypatch.setattr(main, "check_database", lambda: None)


def test_triage_is_a_retryable_503_without_a_graph():
    response = client.post("/triage", json=TICKET)

    assert response.status_code == 503
    assert response.headers["Retry-After"] == str(RETRY_AFTER_SECONDS)
    assert response.json() == {
        "detail": "Triage is starting up or the database is unavailable. Please retry."
    }


def test_ready_is_503_without_a_graph_even_when_the_database_answers():
    response = client.get("/ready")

    assert response.status_code == 503
    assert response.json() == {"status": "not_ready", "reason": "triage graph unavailable"}


def test_health_is_unaffected_by_a_missing_graph():
    assert client.get("/health").json() == {"status": "ok"}


def test_other_endpoints_do_not_need_the_graph(monkeypatch):
    from app.api import tickets as tickets_api

    monkeypatch.setattr(tickets_api, "list_tickets", lambda status, limit: [])

    assert client.get("/tickets").status_code == 200


def test_a_malformed_ticket_also_gets_the_503_while_the_graph_is_missing():
    # FastAPI runs the get_graph dependency before it reports body-validation
    # errors, so the 503 (retry later) wins over the 422 until the graph exists.
    response = client.post("/triage", json={"subject": "no body"})

    assert response.status_code == 503
