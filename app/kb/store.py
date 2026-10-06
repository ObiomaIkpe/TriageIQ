import threading
import time
from collections import OrderedDict

import voyageai
import voyageai.error

from app.config import settings
from app.db import get_connection
from app.kb.ratelimit import RateLimiter
from app.models import KbMatch

EMBEDDING_DIM = 1024  # voyage-3 output dimension
EMBEDDING_MODEL = "voyage-3"

# Cosine distance cutoff for retrieval (0 = identical, higher = less similar).
# Chosen from measurements on the 5 sample articles: real matches landed at
# ~0.33-0.35, everything else at 0.56+. Provisional - retune as the KB grows.
MAX_DISTANCE = 0.5

# Retry policy for Voyage calls: 3 attempts total, waiting 2s then 4s.
MAX_ATTEMPTS = 3
BACKOFF_BASE_SECONDS = 2.0

# Only transient failures are retried. Names are looked up defensively so a
# renamed exception in a future voyageai release can't break import.
_RETRYABLE = tuple(
    getattr(voyageai.error, name)
    for name in (
        "RateLimitError",
        "ServiceUnavailableError",
        "Timeout",
        "APIConnectionError",
    )
    if hasattr(voyageai.error, name)
)

_voyage = voyageai.Client(api_key=settings.voyage_api_key)
_limiter = RateLimiter(max_calls=settings.voyage_rpm, period=60.0)
_sleep = time.sleep

# In-memory LRU cache of embeddings, keyed by (input_type, text).
_CACHE_SIZE = 256
_cache: "OrderedDict[tuple[str, str], list[float]]" = OrderedDict()
_cache_lock = threading.Lock()


def init_schema() -> None:
    """Create the kb_documents table and enforce one row per topic.

    Every statement is safe to run on every startup, on a fresh database or on
    one created before topics were unique.
    """
    with get_connection() as conn:
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS kb_documents (
                id SERIAL PRIMARY KEY,
                topic TEXT NOT NULL,
                content TEXT NOT NULL,
                embedding VECTOR({EMBEDDING_DIM}) NOT NULL
            )
        """)
        # A database created before topics were unique may hold duplicates.
        # Keep the lowest id per topic so the unique index below can be built.
        conn.execute("""
            DELETE FROM kb_documents a USING kb_documents b
            WHERE a.topic = b.topic AND a.id > b.id
        """)
        conn.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS kb_documents_topic_key
            ON kb_documents (topic)
        """)
        # No index at this scale — a handful of rows is faster and more
        # accurate with a plain sequential scan than a poorly-tuned
        # ivfflat index. Revisit once the KB grows into the hundreds+.


def check_database() -> None:
    """Raise if Postgres is unreachable or the knowledge base table is missing."""
    with get_connection() as conn:
        conn.execute("SELECT 1 FROM kb_documents LIMIT 1")


def _embed_with_retry(text: str, input_type: str) -> list[float]:
    for attempt in range(1, MAX_ATTEMPTS + 1):
        _limiter.acquire()
        try:
            result = _voyage.embed(
                [text], model=EMBEDDING_MODEL, input_type=input_type
            )
            return result.embeddings[0]
        except _RETRYABLE:
            if attempt == MAX_ATTEMPTS:
                raise
            _sleep(BACKOFF_BASE_SECONDS * 2 ** (attempt - 1))
    raise AssertionError("unreachable")  # loop always returns or raises


def embed_text(text: str, input_type: str = "document") -> list[float]:
    """input_type is 'document' when embedding KB content, 'query' when
    embedding a ticket to search against it - Voyage tunes embeddings
    differently for each, which improves retrieval quality.

    Results are cached, and uncached calls go through the rate limiter and
    retry policy above."""
    key = (input_type, text)
    with _cache_lock:
        if key in _cache:
            _cache.move_to_end(key)
            return list(_cache[key])

    embedding = _embed_with_retry(text, input_type)

    with _cache_lock:
        _cache[key] = embedding
        _cache.move_to_end(key)
        while len(_cache) > _CACHE_SIZE:
            _cache.popitem(last=False)
    return list(embedding)


def add_document(topic: str, content: str) -> None:
    embedding = embed_text(content, input_type="document")
    with get_connection() as conn:
        conn.execute(
            """
            INSERT INTO kb_documents (topic, content, embedding) VALUES (%s, %s, %s)
            ON CONFLICT (topic) DO UPDATE
              SET content = EXCLUDED.content, embedding = EXCLUDED.embedding
            """,
            (topic, content, embedding),
        )


def search_similar(query_text: str, top_k: int = 3) -> list[KbMatch]:
    """Return up to top_k KB matches within MAX_DISTANCE of the query.

    May return fewer than top_k, or an empty list if nothing is close enough.
    """
    query_embedding = embed_text(query_text, input_type="query")
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT topic, content, embedding <=> %s::vector AS distance
            FROM kb_documents
            WHERE embedding <=> %s::vector < %s
            ORDER BY distance
            LIMIT %s
            """,
            (query_embedding, query_embedding, MAX_DISTANCE, top_k),
        ).fetchall()
    return [
        KbMatch(topic=topic, content=content, distance=distance)
        for topic, content, distance in rows
    ]