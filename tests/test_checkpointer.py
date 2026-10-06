import pytest
from psycopg.rows import dict_row

from app.graph import checkpointer


class FakePool:
    instances = []

    def __init__(self, conninfo, min_size, max_size, kwargs, open):
        self.conninfo = conninfo
        self.min_size = min_size
        self.max_size = max_size
        self.kwargs = kwargs
        self.open_arg = open
        self.opened_with = None
        self.closed = 0
        self.fail_open = False
        FakePool.instances.append(self)

    def open(self, wait, timeout):
        self.opened_with = (wait, timeout)
        if self.fail_open:
            raise TimeoutError("could not connect")

    def close(self):
        self.closed += 1


class FakeSaver:
    instances = []

    def __init__(self, pool):
        self.pool = pool
        self.setup_calls = 0
        self.fail_setup = False
        FakeSaver.instances.append(self)

    def setup(self):
        self.setup_calls += 1
        if self.fail_setup:
            raise RuntimeError("setup failed")


@pytest.fixture(autouse=True)
def fakes(monkeypatch):
    FakePool.instances.clear()
    FakeSaver.instances.clear()
    monkeypatch.setattr(checkpointer, "ConnectionPool", FakePool)
    monkeypatch.setattr(checkpointer, "PostgresSaver", FakeSaver)


# --- libpq_url --------------------------------------------------------------

def test_a_plain_url_is_left_alone():
    url = "postgresql://u:p@localhost:5433/triageiq"

    assert checkpointer.libpq_url(url) == url


def test_a_sqlalchemy_style_url_loses_its_driver_suffix():
    assert (
        checkpointer.libpq_url("postgresql+psycopg://u:p@localhost:5433/triageiq")
        == "postgresql://u:p@localhost:5433/triageiq"
    )


# --- create_checkpointer ----------------------------------------------------

def test_the_pool_gets_the_connection_kwargs_the_saver_needs():
    checkpointer.create_checkpointer("postgresql://u:p@db/x")

    pool = FakePool.instances[0]
    assert pool.kwargs["autocommit"] is True
    assert pool.kwargs["row_factory"] is dict_row
    assert pool.kwargs["prepare_threshold"] == 0


def test_the_url_is_converted_and_the_pool_is_sized():
    checkpointer.create_checkpointer("postgresql+psycopg://u:p@db/x")

    pool = FakePool.instances[0]
    assert pool.conninfo == "postgresql://u:p@db/x"
    assert (pool.min_size, pool.max_size) == (
        checkpointer.POOL_MIN_SIZE, checkpointer.POOL_MAX_SIZE,
    )


def test_it_defaults_to_the_settings_database_url(monkeypatch):
    monkeypatch.setattr(
        checkpointer.settings, "database_url", "postgresql://s:s@settings-host/db"
    )

    checkpointer.create_checkpointer()

    assert FakePool.instances[0].conninfo == "postgresql://s:s@settings-host/db"


def test_the_pool_is_opened_and_waited_for_with_a_timeout():
    checkpointer.create_checkpointer("postgresql://u:p@db/x")

    pool = FakePool.instances[0]
    assert pool.open_arg is False
    assert pool.opened_with == (True, checkpointer.POOL_OPEN_TIMEOUT_SECONDS)


def test_setup_runs_exactly_once_on_the_pool():
    result = checkpointer.create_checkpointer("postgresql://u:p@db/x")

    saver = FakeSaver.instances[0]
    assert saver.setup_calls == 1
    assert saver.pool is FakePool.instances[0]
    assert result.saver is saver
    assert result.pool is FakePool.instances[0]


def test_close_closes_the_pool_once():
    result = checkpointer.create_checkpointer("postgresql://u:p@db/x")
    assert FakePool.instances[0].closed == 0

    result.close()

    assert FakePool.instances[0].closed == 1


def test_an_unreachable_database_raises_and_closes_the_pool(monkeypatch):
    monkeypatch.setattr(FakePool, "open", lambda self, wait, timeout: (_ for _ in ()).throw(
        TimeoutError("could not connect")
    ))

    with pytest.raises(TimeoutError):
        checkpointer.create_checkpointer("postgresql://u:p@db/x")

    assert FakePool.instances[0].closed == 1
    assert FakeSaver.instances == []  # setup was never attempted


def test_a_failed_setup_raises_and_closes_the_pool(monkeypatch):
    monkeypatch.setattr(FakeSaver, "setup", lambda self: (_ for _ in ()).throw(
        RuntimeError("setup failed")
    ))

    with pytest.raises(RuntimeError, match="setup failed"):
        checkpointer.create_checkpointer("postgresql://u:p@db/x")

    assert FakePool.instances[0].closed == 1
