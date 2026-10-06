import pytest
from alembic import command
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.pool import NullPool

from tests.integration.conftest import alembic_config

pytestmark = pytest.mark.integration


def _engine(url):
    return create_engine(url, poolclass=NullPool)


def _index_names(url, table):
    with _engine(url).connect() as conn:
        return {i["name"] for i in inspect(conn).get_indexes(table)}


def test_upgrade_creates_both_tables_and_their_indexes(migrated_database):
    with _engine(migrated_database).connect() as conn:
        tables = set(inspect(conn).get_table_names())

    assert {"kb_documents", "tickets", "alembic_version"} <= tables
    assert "kb_documents_topic_key" in _index_names(migrated_database, "kb_documents")
    assert "tickets_status_created_idx" in _index_names(migrated_database, "tickets")


def test_upgrade_twice_is_a_no_op(migrated_database):
    command.upgrade(alembic_config(migrated_database), "head")

    with _engine(migrated_database).connect() as conn:
        version = conn.execute(text("SELECT version_num FROM alembic_version")).scalar()
    assert version == "0001"


def test_the_orm_models_match_the_migrated_schema(migrated_database):
    # Raises CommandError if autogenerate would produce any change.
    command.check(alembic_config(migrated_database))


def test_upgrade_cleans_an_old_style_database_with_duplicate_topics(clean_database):
    engine = _engine(clean_database)
    with engine.begin() as conn:
        # What the old raw-SQL setup built: no unique index, duplicates allowed.
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        conn.execute(text("""
            CREATE TABLE kb_documents (
                id SERIAL PRIMARY KEY,
                topic TEXT NOT NULL,
                content TEXT NOT NULL,
                embedding VECTOR(1024) NOT NULL
            )
        """))
        conn.execute(text("""
            INSERT INTO kb_documents (topic, content, embedding) VALUES
              ('password reset', 'old copy',   array_fill(0.1::real, ARRAY[1024])::vector),
              ('password reset', 'newer copy', array_fill(0.2::real, ARRAY[1024])::vector),
              ('billing cycle',  'only copy',  array_fill(0.3::real, ARRAY[1024])::vector)
        """))

    command.upgrade(alembic_config(clean_database), "head")

    with engine.connect() as conn:
        rows = conn.execute(
            text("SELECT id, topic, content FROM kb_documents ORDER BY id")
        ).all()
        tables = set(inspect(conn).get_table_names())
    assert rows == [(1, "password reset", "old copy"), (3, "billing cycle", "only copy")]
    assert "kb_documents_topic_key" in _index_names(clean_database, "kb_documents")
    assert "tickets" in tables


def test_the_unique_topic_index_rejects_a_duplicate_topic(migrated_database):
    insert = text(
        "INSERT INTO kb_documents (topic, content, embedding) "
        "VALUES ('t', 'c', array_fill(0.1::real, ARRAY[1024])::vector)"
    )
    engine = _engine(migrated_database)
    with engine.begin() as conn:
        conn.execute(insert)

    with pytest.raises(Exception, match="kb_documents_topic_key"):
        with engine.begin() as conn:
            conn.execute(insert)


def test_downgrade_removes_both_tables(migrated_database):
    command.downgrade(alembic_config(migrated_database), "base")

    with _engine(migrated_database).connect() as conn:
        tables = set(inspect(conn).get_table_names())
    assert "kb_documents" not in tables
    assert "tickets" not in tables
