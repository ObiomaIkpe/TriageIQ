import psycopg
from pgvector.psycopg import register_vector
import voyageai

from app.config import settings

EMBEDDING_DIM = 1024  # voyage-3 output dimension
EMBEDDING_MODEL = "voyage-3"

# Cosine distance cutoff for retrieval (0 = identical, higher = less similar).
# Chosen from measurements on the 5 sample articles: real matches landed at
# ~0.33-0.35, everything else at 0.56+. Provisional - retune as the KB grows.
MAX_DISTANCE = 0.5

_voyage = voyageai.Client(api_key=settings.voyage_api_key)


def get_connection() -> psycopg.Connection:
    conn = psycopg.connect(settings.database_url, autocommit=True)
    conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
    register_vector(conn)
    return conn

def init_schema() -> None:
    """Create the kb_documents table if it doesn't exist yet."""
    with get_connection() as conn:
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS kb_documents (
                id SERIAL PRIMARY KEY,
                topic TEXT NOT NULL,
                content TEXT NOT NULL,
                embedding VECTOR({EMBEDDING_DIM}) NOT NULL
            )
        """)
        # No index at this scale — a handful of rows is faster and more
        # accurate with a plain sequential scan than a poorly-tuned
        # ivfflat index. Revisit once the KB grows into the hundreds+.


def embed_text(text: str, input_type: str = "document") -> list[float]:
    """input_type is 'document' when embedding KB content, 'query' when
    embedding a ticket to search against it - Voyage tunes embeddings
    differently for each, which improves retrieval quality."""
    result = _voyage.embed([text], model=EMBEDDING_MODEL, input_type=input_type)
    return result.embeddings[0]


def add_document(topic: str, content: str) -> None:
    embedding = embed_text(content, input_type="document")
    with get_connection() as conn:
        conn.execute(
            "INSERT INTO kb_documents (topic, content, embedding) VALUES (%s, %s, %s)",
            (topic, content, embedding),
        )


def search_similar(query_text: str, top_k: int = 3) -> list[str]:
    """Return up to top_k KB document contents within MAX_DISTANCE of the query.

    May return fewer than top_k, or an empty list if nothing is close enough.
    """
    query_embedding = embed_text(query_text, input_type="query")
    with get_connection() as conn:
        rows = conn.execute(
            """
            SELECT content FROM kb_documents
            WHERE embedding <=> %s::vector < %s
            ORDER BY embedding <=> %s::vector
            LIMIT %s
            """,
            (query_embedding, MAX_DISTANCE, query_embedding, top_k),
        ).fetchall()
    return [row[0] for row in rows]