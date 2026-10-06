import logging

import pytest
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.pool import NullPool

from app.migrations import run_migrations

pytestmark = pytest.mark.integration


def _tables(url):
    engine = create_engine(url, poolclass=NullPool)
    try:
        with engine.connect() as conn:
            return set(inspect(conn).get_table_names())
    finally:
        engine.dispose()


def test_run_migrations_creates_both_tables(clean_database):
    run_migrations(clean_database)

    assert {"kb_documents", "tickets", "alembic_version"} <= _tables(clean_database)


def test_running_it_again_is_a_no_op(clean_database):
    run_migrations(clean_database)
    run_migrations(clean_database)

    engine = create_engine(clean_database, poolclass=NullPool)
    with engine.connect() as conn:
        versions = conn.execute(text("SELECT version_num FROM alembic_version")).all()
    engine.dispose()
    assert versions == [("0001",)]


def test_running_it_leaves_the_apps_logging_alone(clean_database):
    app_logger = logging.getLogger("app.kb.bootstrap")
    handlers_before = list(logging.getLogger().handlers)
    level_before = logging.getLogger().level
    disabled_before = app_logger.disabled

    run_migrations(clean_database)

    assert list(logging.getLogger().handlers) == handlers_before
    assert logging.getLogger().level == level_before
    assert app_logger.disabled == disabled_before
