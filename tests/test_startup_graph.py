"""The startup hook: migrations, then the Postgres checkpointer and the graph."""
import pytest
from fastapi.testclient import TestClient
from langgraph.checkpoint.memory import MemorySaver

from app import main
from app.errors import RETRY_AFTER_SECONDS
from app.kb import bootstrap
from app.main import app

TICKET = {"subject": "Cannot log in", "body": "Account locked."}


class FakeCheckpointer:
    def __init__(self):
        self.saver = MemorySaver()
        self.closed = 0

    def close(self):
        self.closed += 1


@pytest.fixture
def startup(monkeypatch):
    """Fake the migrations and the checkpointer; keep the real retry logic but
    skip its sleeps. Records what happened, in order."""

    class Startup:
        pass

    s = Startup()
    s.events = []
    s.checkpointers = []
    s.create_failures = 0  # how many create_checkpointer calls fail first

    monkeypatch.setattr(main, "run_migrations", lambda: s.events.append("migrations"))
    monkeypatch.setattr(main, "check_database", lambda: None)

    def create():
        s.events.append("create_checkpointer")
        if s.create_failures > 0:
            s.create_failures -= 1
            raise ConnectionError("database is down")
        cp = FakeCheckpointer()
        s.checkpointers.append(cp)
        return cp

    monkeypatch.setattr(main, "create_checkpointer", create)

    real = bootstrap.init_schema_with_retry
    monkeypatch.setattr(
        main,
        "init_schema_with_retry",
        lambda init, **kwargs: real(init, sleep=lambda seconds: None, **kwargs),
    )
    # The autouse fixture's override would hide what get_graph really does.
    app.dependency_overrides.clear()
    monkeypatch.setattr(app.state, "triage_graph", None, raising=False)
    return s


def test_migrations_run_before_the_graph_is_created(startup):
    with TestClient(app):
        pass

    assert startup.events == ["migrations", "create_checkpointer"]


def test_the_graph_is_stored_on_app_state_with_the_postgres_saver(startup):
    with TestClient(app):
        graph = app.state.triage_graph

        assert graph is not None
        assert graph.checkpointer is startup.checkpointers[0].saver


def test_the_app_is_ready_once_the_graph_is_built(startup):
    with TestClient(app) as client:
        assert client.get("/ready").json() == {"status": "ready"}


def test_shutdown_closes_the_pool_once_and_clears_the_graph(startup):
    with TestClient(app):
        assert startup.checkpointers[0].closed == 0

    assert startup.checkpointers[0].closed == 1
    assert app.state.triage_graph is None


def test_a_transient_failure_is_retried_and_then_succeeds(startup):
    startup.create_failures = 2

    with TestClient(app):
        assert app.state.triage_graph is not None

    assert startup.events.count("create_checkpointer") == 3
    assert len(startup.checkpointers) == 1


def test_when_every_attempt_fails_the_app_still_boots_without_a_graph(startup):
    startup.create_failures = 99

    with TestClient(app) as client:
        assert app.state.triage_graph is None
        assert client.get("/health").json() == {"status": "ok"}

    assert startup.events.count("create_checkpointer") == main.GRAPH_STARTUP_ATTEMPTS
    assert startup.checkpointers == []


def test_without_a_graph_triage_is_a_retryable_503_and_ready_is_503(startup):
    startup.create_failures = 99

    with TestClient(app) as client:
        triage = client.post("/triage", json=TICKET)
        ready = client.get("/ready")

    assert triage.status_code == 503
    assert triage.headers["Retry-After"] == str(RETRY_AFTER_SECONDS)
    assert triage.json() == {
        "detail": "Triage is starting up or the database is unavailable. Please retry."
    }
    assert ready.status_code == 503
    assert ready.json() == {"status": "not_ready", "reason": "triage graph unavailable"}


def test_a_graph_that_fails_to_build_closes_its_pool(startup, monkeypatch):
    def boom(saver):
        raise RuntimeError("cannot compile")

    monkeypatch.setattr(main, "build_triage_graph", boom)

    with TestClient(app):
        assert app.state.triage_graph is None

    assert len(startup.checkpointers) == main.GRAPH_STARTUP_ATTEMPTS
    assert all(cp.closed == 1 for cp in startup.checkpointers)


def test_the_database_check_still_comes_first_in_ready(startup, monkeypatch):
    def down():
        raise ConnectionError("postgres is down")

    monkeypatch.setattr(main, "check_database", down)

    with TestClient(app) as client:
        response = client.get("/ready")

    assert response.status_code == 503
    assert response.json() == {"status": "not_ready", "reason": "database unavailable"}
