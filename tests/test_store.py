import pytest
import voyageai.error

from app.kb import store


class FakeVoyage:
    """Stands in for voyageai.Client. `errors` are raised first, one per call."""

    def __init__(self):
        self.calls = []
        self.errors = []

    def embed(self, texts, model, input_type):
        self.calls.append(
            {"texts": texts, "model": model, "input_type": input_type}
        )
        if self.errors:
            raise self.errors.pop(0)

        class Result:
            embeddings = [[0.1, 0.2, 0.3]]

        return Result()


class FakeLimiter:
    def __init__(self):
        self.acquired = 0

    def acquire(self):
        self.acquired += 1


class FakeConn:
    """Stands in for a psycopg connection used as a context manager."""

    def __init__(self, rows=None):
        self.rows = rows or []
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        return self

    def fetchall(self):
        return self.rows


@pytest.fixture(autouse=True)
def fakes(monkeypatch):
    class Fakes:
        pass

    f = Fakes()
    f.voyage = FakeVoyage()
    f.limiter = FakeLimiter()
    f.sleeps = []

    store._cache.clear()
    monkeypatch.setattr(store, "_voyage", f.voyage)
    monkeypatch.setattr(store, "_limiter", f.limiter)
    monkeypatch.setattr(store, "_sleep", f.sleeps.append)
    yield f
    store._cache.clear()


def rate_limit_error():
    return voyageai.error.RateLimitError("rate limited")


# --- embed_text: basics and cache -------------------------------------------

def test_embed_text_returns_the_embedding_and_sends_model_and_type(fakes):
    result = store.embed_text("hello", input_type="query")

    assert result == [0.1, 0.2, 0.3]
    assert fakes.voyage.calls == [
        {"texts": ["hello"], "model": store.EMBEDDING_MODEL, "input_type": "query"}
    ]


def test_same_text_and_type_is_served_from_cache(fakes):
    store.embed_text("hello", "query")
    store.embed_text("hello", "query")

    assert len(fakes.voyage.calls) == 1


def test_cache_hit_does_not_use_rate_limit_quota(fakes):
    store.embed_text("hello", "query")
    store.embed_text("hello", "query")

    assert fakes.limiter.acquired == 1


def test_same_text_with_different_input_type_is_not_shared(fakes):
    store.embed_text("hello", "query")
    store.embed_text("hello", "document")

    assert len(fakes.voyage.calls) == 2


def test_oldest_entry_is_evicted_when_cache_is_full(fakes, monkeypatch):
    monkeypatch.setattr(store, "_CACHE_SIZE", 2)

    store.embed_text("a", "query")
    store.embed_text("b", "query")
    store.embed_text("c", "query")  # evicts "a"
    store.embed_text("a", "query")  # must call Voyage again

    assert len(fakes.voyage.calls) == 4


def test_mutating_a_returned_embedding_does_not_corrupt_the_cache(fakes):
    first = store.embed_text("hello", "query")
    first.append(999)

    assert store.embed_text("hello", "query") == [0.1, 0.2, 0.3]


# --- embed_text: retry ------------------------------------------------------

def test_retryable_error_is_retried_with_backoff(fakes):
    fakes.voyage.errors = [rate_limit_error()]

    result = store.embed_text("hello", "query")

    assert result == [0.1, 0.2, 0.3]
    assert len(fakes.voyage.calls) == 2
    assert fakes.sleeps == [2.0]


def test_every_attempt_goes_through_the_rate_limiter(fakes):
    fakes.voyage.errors = [rate_limit_error()]

    store.embed_text("hello", "query")

    assert fakes.limiter.acquired == 2


def test_gives_up_after_max_attempts(fakes):
    fakes.voyage.errors = [rate_limit_error() for _ in range(3)]

    with pytest.raises(voyageai.error.RateLimitError):
        store.embed_text("hello", "query")

    assert len(fakes.voyage.calls) == 3
    assert fakes.sleeps == [2.0, 4.0]


def test_failed_embedding_is_not_cached(fakes):
    fakes.voyage.errors = [rate_limit_error() for _ in range(3)]
    with pytest.raises(voyageai.error.RateLimitError):
        store.embed_text("hello", "query")

    assert store.embed_text("hello", "query") == [0.1, 0.2, 0.3]


def test_non_retryable_error_is_raised_immediately(fakes):
    fakes.voyage.errors = [ValueError("bad input")]

    with pytest.raises(ValueError):
        store.embed_text("hello", "query")

    assert len(fakes.voyage.calls) == 1
    assert fakes.sleeps == []


# --- search_similar and add_document ----------------------------------------

def test_search_similar_runs_the_cutoff_query_and_returns_contents(fakes, monkeypatch):
    conn = FakeConn(rows=[("Article A",), ("Article B",)])
    monkeypatch.setattr(store, "get_connection", lambda: conn)

    result = store.search_similar("lockout", top_k=2)

    assert result == ["Article A", "Article B"]
    sql, params = conn.executed[0]
    assert "::vector" in sql
    assert "LIMIT" in sql
    assert params == ([0.1, 0.2, 0.3], store.MAX_DISTANCE, [0.1, 0.2, 0.3], 2)


def test_search_similar_embeds_the_query_as_a_query(fakes, monkeypatch):
    monkeypatch.setattr(store, "get_connection", lambda: FakeConn())

    store.search_similar("lockout")

    assert fakes.voyage.calls[0]["input_type"] == "query"


def test_search_similar_with_no_rows_returns_empty_list(fakes, monkeypatch):
    monkeypatch.setattr(store, "get_connection", lambda: FakeConn(rows=[]))

    assert store.search_similar("weather in paris") == []


def test_add_document_embeds_as_document_and_inserts(fakes, monkeypatch):
    conn = FakeConn()
    monkeypatch.setattr(store, "get_connection", lambda: conn)

    store.add_document("lockout", "Accounts lock after 5 attempts.")

    assert fakes.voyage.calls[0]["input_type"] == "document"
    sql, params = conn.executed[0]
    assert sql.strip().startswith("INSERT INTO kb_documents")
    assert params == ("lockout", "Accounts lock after 5 attempts.", [0.1, 0.2, 0.3])


# --- check_database ---------------------------------------------------------

def test_check_database_queries_the_kb_table(monkeypatch):
    conn = FakeConn()
    monkeypatch.setattr(store, "get_connection", lambda: conn)

    store.check_database()

    assert conn.executed[0][0] == "SELECT 1 FROM kb_documents LIMIT 1"


def test_check_database_raises_when_the_database_is_down(monkeypatch):
    def down():
        raise ConnectionError("postgres is down")

    monkeypatch.setattr(store, "get_connection", down)

    with pytest.raises(ConnectionError):
        store.check_database()