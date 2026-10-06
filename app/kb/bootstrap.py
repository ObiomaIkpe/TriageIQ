import logging
import time
from collections.abc import Callable

logger = logging.getLogger(__name__)


def init_schema_with_retry(
    init: Callable[[], None],
    attempts: int = 5,
    delay: float = 2.0,
    sleep: Callable[[float], None] = time.sleep,
    label: str = "Schema init",
    failure_message: str = (
        "Could not apply the database migrations; continuing without them"
    ),
) -> bool:
    """Run init(), retrying while the database is still starting up.

    Used for the startup steps that need the database (the migrations, then the
    triage graph). Returns True once it succeeds. If every attempt fails it logs
    the error and returns False instead of raising, so the app still boots and
    the database-backed parts degrade gracefully rather than taking the whole
    service down. `label` and `failure_message` only change the log text.
    """
    for attempt in range(1, attempts + 1):
        try:
            init()
            return True
        except Exception:
            logger.warning(
                "%s failed (attempt %d/%d)", label, attempt, attempts, exc_info=True
            )
            if attempt < attempts:
                sleep(delay)
    logger.error(failure_message)
    return False