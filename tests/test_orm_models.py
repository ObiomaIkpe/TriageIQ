from app.db import Base
from app.kb import orm as kb_orm
from app.kb import store as kb_store
from app.kb.orm import KbDocumentRow
from app.tickets.orm import TicketRow


def _index(table, name):
    return next(i for i in table.indexes if i.name == name)


def test_both_tables_are_registered_on_the_shared_base():
    assert {"kb_documents", "tickets"} <= set(Base.metadata.tables)


# --- kb_documents -----------------------------------------------------------

def test_kb_documents_columns_and_nullability():
    columns = KbDocumentRow.__table__.c

    assert list(columns.keys()) == ["id", "topic", "content", "embedding"]
    assert columns.id.primary_key
    assert not columns.topic.nullable
    assert not columns.content.nullable
    assert not columns.embedding.nullable


def test_kb_documents_has_a_unique_topic_index_with_the_old_name():
    index = _index(KbDocumentRow.__table__, "kb_documents_topic_key")

    assert index.unique is True
    assert [c.name for c in index.columns] == ["topic"]


def test_embedding_column_has_the_voyage_dimension():
    assert KbDocumentRow.__table__.c.embedding.type.dim == 1024


def test_the_store_uses_the_orms_embedding_dimension():
    # One definition, imported by the store, so the two can never disagree.
    assert kb_store.EMBEDDING_DIM is kb_orm.EMBEDDING_DIM


# --- tickets ----------------------------------------------------------------

def test_tickets_columns_match_the_raw_sql_schema():
    assert list(TicketRow.__table__.c.keys()) == [
        "id", "status", "subject", "body", "customer_id",
        "category", "urgency", "confidence", "routing_target",
        "suggested_reply", "kb_sources", "needs_human_review", "review_reason",
        "created_at", "updated_at",
    ]


def test_tickets_nullable_columns_are_only_the_optional_ones():
    nullable = {c.name for c in TicketRow.__table__.c if c.nullable}

    assert nullable == {"customer_id", "suggested_reply", "review_reason"}


def test_tickets_id_is_a_uuid_primary_key_generated_by_the_database():
    column = TicketRow.__table__.c.id

    assert column.primary_key
    assert "gen_random_uuid()" in str(column.server_default.arg)


def test_tickets_kb_sources_defaults_to_an_empty_json_list():
    column = TicketRow.__table__.c.kb_sources

    assert not column.nullable
    assert "'[]'" in str(column.server_default.arg)


def test_tickets_has_the_status_created_index_with_the_old_name():
    index = _index(TicketRow.__table__, "tickets_status_created_idx")

    assert index.unique is not True
    assert [c.name for c in index.columns] == ["status", "created_at"]
