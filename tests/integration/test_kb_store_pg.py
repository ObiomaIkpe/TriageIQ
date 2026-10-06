"""The knowledge base store against a real Postgres with pgvector.

Embeddings are hand-built so cosine distances are known exactly, and no Voyage
call is made: embed_text is replaced by a lookup from text to vector.
"""
import math

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import ProgrammingError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool
from sqlalchemy import create_engine

from app import db
from app.kb import ingest, store
from app.kb.orm import EMBEDDING_DIM, KbDocumentRow
from app.models import KbMatch

pytestmark = pytest.mark.integration


def unit(i: int) -> list[float]:
    """A vector with a 1 at position i. Any two different ones are 1.0 apart."""
    v = [0.0] * EMBEDDING_DIM
    v[i] = 1.0
    return v


def mix(i: int, a: float, j: int, b: float) -> list[float]:
    v = [0.0] * EMBEDDING_DIM
    v[i], v[j] = a, b
    return v


def distance_to_unit_i(a: float, b: float) -> float:
    """Cosine distance between mix(i, a, j, b) and unit(i)."""
    return 1 - a / math.sqrt(a * a + b * b)


@pytest.fixture
def embeddings(monkeypatch, test_session):
    """Replace embed_text with a lookup table the test fills in."""
    table = {}

    def fake_embed(text, input_type="document"):
        return table[text]

    monkeypatch.setattr(store, "embed_text", fake_embed)
    return table


def all_rows(test_session):
    with test_session.begin() as session:
        return session.execute(
            select(KbDocumentRow.topic, KbDocumentRow.content).order_by(KbDocumentRow.id)
        ).all()


def test_a_saved_document_is_found_by_its_own_embedding(embeddings):
    embeddings["Reset emails expire after 30 minutes."] = unit(0)
    embeddings["how do I reset my password"] = unit(0)

    store.add_document("password reset", "Reset emails expire after 30 minutes.")
    result = store.search_similar("how do I reset my password")

    assert len(result) == 1
    assert result[0].topic == "password reset"
    assert result[0].content == "Reset emails expire after 30 minutes."
    assert result[0].distance == pytest.approx(0.0, abs=1e-6)
    assert isinstance(result[0], KbMatch)


def test_results_are_ordered_closest_first(embeddings):
    embeddings["close"] = mix(0, 1.0, 1, 1.0)   # distance ~0.293 from unit(0)
    embeddings["exact"] = unit(0)               # distance 0
    embeddings["query"] = unit(0)

    store.add_document("close topic", "close")
    store.add_document("exact topic", "exact")
    result = store.search_similar("query")

    assert [m.topic for m in result] == ["exact topic", "close topic"]
    assert result[0].distance == pytest.approx(0.0, abs=1e-6)
    assert result[1].distance == pytest.approx(distance_to_unit_i(1.0, 1.0), abs=1e-5)


def test_documents_beyond_the_cutoff_are_not_returned(embeddings):
    far = mix(0, 1.0, 1, 3.0)
    assert distance_to_unit_i(1.0, 3.0) > store.MAX_DISTANCE  # ~0.68
    embeddings["far"] = far
    embeddings["orthogonal"] = unit(5)          # distance 1.0
    embeddings["near"] = mix(0, 1.0, 1, 1.0)    # ~0.29, inside the cutoff
    embeddings["query"] = unit(0)

    store.add_document("far topic", "far")
    store.add_document("orthogonal topic", "orthogonal")
    store.add_document("near topic", "near")
    result = store.search_similar("query")

    assert [m.topic for m in result] == ["near topic"]


def test_nothing_close_enough_returns_an_empty_list(embeddings):
    embeddings["orthogonal"] = unit(5)
    embeddings["query"] = unit(0)
    store.add_document("orthogonal topic", "orthogonal")

    assert store.search_similar("query") == []


def test_an_empty_table_returns_an_empty_list(embeddings):
    embeddings["query"] = unit(0)

    assert store.search_similar("query") == []


def test_top_k_limits_the_number_of_results(embeddings):
    for n in range(4):
        embeddings[f"doc {n}"] = mix(0, 1.0, n + 1, 0.1 * n)
        store.add_document(f"topic {n}", f"doc {n}")
    embeddings["query"] = unit(0)

    assert len(store.search_similar("query", top_k=2)) == 2
    assert len(store.search_similar("query", top_k=10)) == 4


# --- add_document is an upsert ----------------------------------------------

def test_saving_the_same_topic_twice_updates_it_in_place(embeddings, test_session):
    embeddings["first version"] = unit(0)
    embeddings["second version"] = unit(7)
    embeddings["query for second"] = unit(7)

    store.add_document("password reset", "first version")
    store.add_document("password reset", "second version")

    assert all_rows(test_session) == [("password reset", "second version")]
    # The embedding was updated too, not just the text.
    result = store.search_similar("query for second")
    assert [m.content for m in result] == ["second version"]


def test_updating_a_topic_keeps_its_id(embeddings, test_session):
    embeddings["v1"] = unit(0)
    embeddings["v2"] = unit(1)
    store.add_document("topic", "v1")
    with test_session.begin() as session:
        first_id = session.scalar(select(KbDocumentRow.id))

    store.add_document("topic", "v2")

    with test_session.begin() as session:
        assert session.scalar(select(KbDocumentRow.id)) == first_id


def test_different_topics_are_separate_rows(embeddings, test_session):
    embeddings["a"] = unit(0)
    embeddings["b"] = unit(1)

    store.add_document("topic a", "a")
    store.add_document("topic b", "b")

    assert all_rows(test_session) == [("topic a", "a"), ("topic b", "b")]


def test_ingesting_the_sample_documents_twice_leaves_one_row_per_topic(
    embeddings, test_session
):
    for doc in ingest.SAMPLE_DOCS:
        embeddings[doc["content"]] = unit(0)

    for _ in range(2):
        for doc in ingest.SAMPLE_DOCS:
            store.add_document(doc["topic"], doc["content"])

    with test_session.begin() as session:
        count = session.scalar(select(func.count()).select_from(KbDocumentRow))
    assert count == len(ingest.SAMPLE_DOCS)


# --- check_database ---------------------------------------------------------

def test_check_database_passes_when_the_table_exists(test_session):
    store.check_database()


def test_check_database_fails_when_the_table_is_missing(clean_database, monkeypatch):
    engine = create_engine(clean_database, poolclass=NullPool)
    monkeypatch.setattr(db, "SessionLocal", sessionmaker(engine, expire_on_commit=False))

    with pytest.raises(ProgrammingError):
        store.check_database()
    engine.dispose()
