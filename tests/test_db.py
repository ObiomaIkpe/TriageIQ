from app import db


def test_plain_postgresql_url_gets_the_psycopg_driver():
    assert (
        db.sqlalchemy_url("postgresql://u:p@localhost:5432/triageiq")
        == "postgresql+psycopg://u:p@localhost:5432/triageiq"
    )


def test_a_url_that_already_names_a_driver_is_left_alone():
    url = "postgresql+psycopg://u:p@localhost:5432/triageiq"

    assert db.sqlalchemy_url(url) == url


def test_the_engine_uses_the_psycopg_driver_without_connecting():
    # create_engine is lazy, so this proves importing app.db needs no database.
    assert db.engine.url.drivername == "postgresql+psycopg"


def test_get_session_commits_when_the_block_succeeds(monkeypatch):
    events = []

    class FakeSession:
        pass

    class FakeBegin:
        def __enter__(self):
            events.append("begin")
            return FakeSession()

        def __exit__(self, exc_type, exc, tb):
            events.append("rollback" if exc_type else "commit")
            return False

    monkeypatch.setattr(db.SessionLocal, "begin", lambda: FakeBegin())

    with db.get_session() as session:
        assert isinstance(session, FakeSession)

    assert events == ["begin", "commit"]


def test_get_session_rolls_back_when_the_block_raises(monkeypatch):
    events = []

    class FakeBegin:
        def __enter__(self):
            return object()

        def __exit__(self, exc_type, exc, tb):
            events.append("rollback" if exc_type else "commit")
            return False

    monkeypatch.setattr(db.SessionLocal, "begin", lambda: FakeBegin())

    try:
        with db.get_session():
            raise RuntimeError("boom")
    except RuntimeError:
        pass

    assert events == ["rollback"]
