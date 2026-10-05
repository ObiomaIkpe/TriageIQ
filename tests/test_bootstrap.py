from app.kb.bootstrap import init_schema_with_retry


class FlakyInit:
    """Fails `failures` times, then succeeds."""

    def __init__(self, failures):
        self.failures = failures
        self.calls = 0

    def __call__(self):
        self.calls += 1
        if self.calls <= self.failures:
            raise ConnectionError("db not ready")


def test_succeeds_first_time_without_sleeping():
    init, sleeps = FlakyInit(0), []

    assert init_schema_with_retry(init, sleep=sleeps.append) is True
    assert init.calls == 1
    assert sleeps == []


def test_retries_until_the_database_is_ready():
    init, sleeps = FlakyInit(2), []

    result = init_schema_with_retry(init, attempts=5, delay=2.0, sleep=sleeps.append)

    assert result is True
    assert init.calls == 3
    assert sleeps == [2.0, 2.0]


def test_gives_up_without_raising_after_all_attempts():
    init, sleeps = FlakyInit(99), []

    result = init_schema_with_retry(init, attempts=3, delay=1.0, sleep=sleeps.append)

    assert result is False
    assert init.calls == 3
    assert sleeps == [1.0, 1.0]  # no pointless sleep after the last attempt