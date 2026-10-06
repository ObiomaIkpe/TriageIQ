from pgvector.sqlalchemy import Vector
from sqlalchemy import Index, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base

EMBEDDING_DIM = 1024  # voyage-3 output dimension


class KbDocumentRow(Base):
    __tablename__ = "kb_documents"

    id: Mapped[int] = mapped_column(primary_key=True)
    topic: Mapped[str] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text)
    # No vector index at this scale: a handful of rows is faster and more
    # accurate with a plain sequential scan than a poorly-tuned ivfflat index.
    # Revisit once the KB grows into the hundreds or more.
    embedding: Mapped[list[float]] = mapped_column(Vector(EMBEDDING_DIM))

    # One row per topic. The name matches the index the raw-SQL setup created.
    __table_args__ = (Index("kb_documents_topic_key", "topic", unique=True),)
