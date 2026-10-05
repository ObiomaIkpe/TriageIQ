from fastapi.testclient import TestClient

from app import main
from app.main import app

# Not used as a context manager, so the startup hook does not run here.
client = TestClient(app)


def test_ready_when_the_database_answers(monkeypatch):
    monkeypatch.setattr(main, "check_database", lambda: None)

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


def test_startup_initialises_the_schema_once(monkeypatch):
    calls = []
    monkeypatch.setattr(
        main, "init_schema_with_retry", lambda init: calls.append(init)
    )

    with TestClient(app):
        pass

    assert calls == [main.init_schema]