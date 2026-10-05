import logging
import time
from collections.abc import Callable

logger = logging.getLogger(__name__)


def init_schema_with_retry(
    init: Callable[[], None],
    attempts: int = 5,
    delay: float = 2.0,
    sleep: Callable[[float], None] = time.sleep,
) -> bool:
    """Run init(), retrying while the database is still starting up.

    Returns True once it succeeds. If every attempt fails it logs the error and
    returns False instead of raising, so the app still boots and the knowledge
    base degrades gracefully rather than taking the whole service down.
    """
    for attempt in range(1, attempts + 1):
        try:
            init()
            return True
        except Exception:
            logger.warning(
                "Schema init failed (attempt %d/%d)", attempt, attempts, exc_info=True
            )
            if attempt < attempts:
                sleep(delay)
    logger.error("Could not initialise the knowledge base schema; continuing without it")
    return False