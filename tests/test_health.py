from fastapi.testclient import TestClient

from app import main
from app.main import app

# Not used as a context manager, so the startup hook does not run here.
client = TestClient(app)


def test_ready_when_the_database_answers_and_the_graph_is_built(monkeypatch):
    monkeypatch.setattr(main, "check_database", lambda: None)
    # What the startup hook would have stored; it does not run in these tests.
    monkeypatch.setattr(app.state, "triage_graph", object(), raising=False)

    response = client.get("/ready")

    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


def test_not_ready_when_the_database_is_down(monkeypatch):
    def down():
        raise ConnectionError("postgres is down")

    monkeypatch.setattr(main, "check_database", down)

    response = client.get("/ready")

    assert response.status_code == 503
    assert response.json() == {
        "status": "not_ready",
        "reason": "database unavailable",
    }


def test_startup_runs_the_migrations_once_then_builds_the_graph(monkeypatch):
    calls = []
    monkeypatch.setattr(
        main, "init_schema_with_retry", lambda init, **kwargs: calls.append(init)
    )

    with TestClient(app):
        pass

    assert len(calls) == 2
    assert calls[0] is main.run_migrations
    assert calls[1].func is main._open_graph