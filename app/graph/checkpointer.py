"""The Postgres checkpointer: saves the graph's state for every run.

Alembic creates every table in this app EXCEPT these. The checkpoint tables
(checkpoints, checkpoint_blobs, checkpoint_writes, checkpoint_migrations) belong
to the langgraph-checkpoint-postgres library, which creates and upgrades them
itself in PostgresSaver.setup(). They are deliberately not in our migrations or
ORM models, so the library can change its own schema between versions.
"""
from dataclasses import dataclass
from typing import Optional

from langgraph.checkpoint.postgres import PostgresSaver
from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from app.config import settings
from app.models import Category, ClassificationResult, KbMatch, TicketIn, Urgency

# Our own types that sit in the graph state, so they are stored in every
# checkpoint. Naming them is how the checkpoint library is told "these are ours,
# load them". Any other custom type found in a checkpoint is BLOCKED when it is
# read: it comes back as a plain dict, with only a log message. So when a new
# type is added to GraphState (or to a model inside it), add it here too;
# tests/test_checkpointer.py fails if one is missing.
CHECKPOINT_TYPES = (TicketIn, ClassificationResult, KbMatch, Category, Urgency)

POOL_MIN_SIZE = 1
POOL_MAX_SIZE = 4
# Fail fast when the database is unreachable, so the startup retry can retry.
POOL_OPEN_TIMEOUT_SECONDS = 5.0


def checkpoint_serde() -> JsonPlusSerializer:
    """The serializer for checkpoints: built-in safe types plus CHECKPOINT_TYPES."""
    return JsonPlusSerializer(allowed_msgpack_modules=CHECKPOINT_TYPES)


def libpq_url(url: str) -> str:
    """A plain postgresql:// URL, which is what a psycopg pool expects.

    Strips the "+psycopg" driver suffix from a SQLAlchemy-style URL.
    """
    return url.replace("postgresql+psycopg://", "postgresql://", 1)


@dataclass
class PostgresCheckpointer:
    saver: PostgresSaver
    pool: ConnectionPool

    def close(self) -> None:
        """Close the connection pool. Call once, at shutdown."""
        self.pool.close()


def create_checkpointer(url: Optional[str] = None) -> PostgresCheckpointer:
    """Open a connection pool and set up the library's checkpoint tables.

    Raises if the database cannot be reached or set up; the pool is closed
    first, so a failed attempt leaves no connections or threads behind.
    """
    pool = ConnectionPool(
        conninfo=libpq_url(url or settings.database_url),
        min_size=POOL_MIN_SIZE,
        max_size=POOL_MAX_SIZE,
        # The saver needs autocommit and dict rows. prepare_threshold=0 turns off
        # server-side prepared statements, which the library recommends for pools.
        kwargs={"autocommit": True, "prepare_threshold": 0, "row_factory": dict_row},
        open=False,
    )
    try:
        pool.open(wait=True, timeout=POOL_OPEN_TIMEOUT_SECONDS)
        saver = PostgresSaver(pool, serde=checkpoint_serde())
        saver.setup()  # creates the library's tables; safe to repeat
    except Exception:
        pool.close()
        raise
    return PostgresCheckpointer(saver=saver, pool=pool)
