import threading
import time
from collections import deque


class RateLimiter:
    """Sliding-window limiter: at most max_calls per period seconds.

    acquire() blocks until a slot is free. The lock is held while waiting on
    purpose, so concurrent threads queue up instead of racing past the limit.
    clock and sleep are injectable so tests don't need real time.
    """

    def __init__(self, max_calls, period=60.0, clock=time.monotonic, sleep=time.sleep):
        if max_calls < 1:
            raise ValueError("max_calls must be at least 1")
        self._max_calls = max_calls
        self._period = period
        self._clock = clock
        self._sleep = sleep
        self._calls = deque()
        self._lock = threading.Lock()

    def acquire(self):
        with self._lock:
            while True:
                now = self._clock()
                while self._calls and now - self._calls[0] >= self._period:
                    self._calls.popleft()
                if len(self._calls) < self._max_calls:
                    self._calls.append(now)
                    return
                self._sleep(self._period - (now - self._calls[0]))