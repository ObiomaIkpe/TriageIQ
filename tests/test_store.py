import pytest

from app.kb.ratelimit import RateLimiter


class FakeTime:
    """A clock whose sleep() just moves time forward."""

    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def clock(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


@pytest.fixture
def ft():
    return FakeTime()


def make_limiter(ft, max_calls=3, period=60.0):
    return RateLimiter(max_calls, period, clock=ft.clock, sleep=ft.sleep)


def test_calls_under_the_limit_do_not_wait(ft):
    limiter = make_limiter(ft)

    for _ in range(3):
        limiter.acquire()

    assert ft.sleeps == []


def test_call_over_the_limit_waits_for_the_window(ft):
    limiter = make_limiter(ft)
    for _ in range(3):
        limiter.acquire()

    limiter.acquire()

    assert ft.sleeps == [60.0]


def test_wait_is_only_the_time_remaining_in_the_window(ft):
    limiter = make_limiter(ft)
    for _ in range(3):
        limiter.acquire()
    ft.now = 45.0

    limiter.acquire()

    assert ft.sleeps == [15.0]


def test_no_wait_once_the_window_has_passed(ft):
    limiter = make_limiter(ft)
    for _ in range(3):
        limiter.acquire()
    ft.now = 60.0

    limiter.acquire()

    assert ft.sleeps == []


def test_limit_of_one_spaces_calls_a_full_period_apart(ft):
    limiter = make_limiter(ft, max_calls=1)

    limiter.acquire()
    limiter.acquire()
    limiter.acquire()

    assert ft.sleeps == [60.0, 60.0]


@pytest.mark.parametrize("bad", [0, -1])
def test_max_calls_must_be_positive(bad):
    with pytest.raises(ValueError):
        RateLimiter(bad)