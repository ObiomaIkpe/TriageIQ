"""Fixtures for tests that need a real Postgres with pgvector.

These tests are opt-in: set TEST_DATABASE_URL, for example

    TEST_DATABASE_URL=postgresql://triageiq:triageiq@localhost:5433/triageiq_test

The database name must end in "_test". It is created if missing and its public
schema is wiped before each test, so never point this at a database you care
about. Without the variable the tests are skipped, and the settings'
DATABASE_URL is never used.
"""
import os

import psycopg
import pytest
from alembic import command
from psycopg import sql
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from app import db
from app.db import sqlalchemy_url
from app.migrations import alembic_config  # noqa: F401  (re-exported for the tests)


@pytest.fixture(scope="session")
def test_database_url() -> str:
    raw = os.environ.get("TEST_DATABASE_URL")
    if not raw:
        pytest.skip("set TEST_DATABASE_URL to run the Postgres integration tests")

    url = make_url(sqlalchemy_url(raw))
    if not url.database or not url.database.endswith("_test"):
        pytest.fail("TEST_DATABASE_URL must name a database whose name ends in _test")

    # Create the database if it is missing, through the server's maintenance DB.
    admin = url.set(drivername="postgresql", database="postgres")
    try:
        with psycopg.connect(
            admin.render_as_string(hide_password=False),
            autocommit=True,
            connect_timeout=3,
        ) as conn:
            exists = conn.execute(
                "SELECT 1 FROM pg_database WHERE datname = %s", (url.database,)
            ).fetchone()
            if not exists:
                conn.execute(
                    sql.SQL("CREATE DATABASE {}").format(sql.Identifier(url.database))
                )
    except psycopg.OperationalError as exc:
        pytest.skip(f"Postgres is not reachable: {exc}")

    return url.render_as_string(hide_password=False)


@pytest.fixture
def clean_database(test_database_url: str) -> str:
    """The test database with an empty public schema (nothing migrated yet)."""
    engine = create_engine(
        test_database_url, poolclass=NullPool, isolation_level="AUTOCOMMIT"
    )
    with engine.connect() as conn:
        conn.execute(text("DROP SCHEMA public CASCADE"))
        conn.execute(text("CREATE SCHEMA public"))
    engine.dispose()
    return test_database_url


@pytest.fixture
def migrated_database(clean_database: str) -> str:
    """The test database after `alembic upgrade head`."""
    command.upgrade(alembic_config(clean_database), "head")
    return clean_database


@pytest.fixture
def test_session(migrated_database: str, monkeypatch):
    """Point the app's session factory at the migrated test database.

    The stores call app.db.get_session(), which reads app.db.SessionLocal, so
    patching it sends their queries to the test database. Yields a factory for
    sessions the tests can use directly.
    """
    engine = create_engine(migrated_database, poolclass=NullPool)
    factory = sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(db, "SessionLocal", factory)
    yield factory
    engine.dispose()
