from collections.abc import Iterator
from contextlib import contextmanager

import psycopg
from pgvector.psycopg import register_vector
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


def sqlalchemy_url(url: str) -> str:
    """Add the driver to a plain postgresql:// URL.

    Without it SQLAlchemy would pick psycopg2, which is not installed.
    """
    prefix = "postgresql://"
    if url.startswith(prefix):
        return "postgresql+psycopg://" + url[len(prefix):]
    return url


class Base(DeclarativeBase):
    """Parent of every ORM model; Alembic reads its metadata."""


# Creating the engine does not connect, so importing this module needs no database.
engine = create_engine(sqlalchemy_url(settings.database_url), pool_pre_ping=True)
SessionLocal = sessionmaker(engine, expire_on_commit=False)


@contextmanager
def get_session() -> Iterator[Session]:
    """One transaction: commits when the block succeeds, rolls back if it raises."""
    with SessionLocal.begin() as session:
        yield session


# Raw connection used by the stores until they move to SQLAlchemy.
def get_connection() -> psycopg.Connection:
    conn = psycopg.connect(settings.database_url, autocommit=True)
    conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
    register_vector(conn)
    return conn
