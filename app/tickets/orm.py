import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, DateTime, Double, Index, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class TicketRow(Base):
    __tablename__ = "tickets"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        server_default=text("gen_random_uuid()"),
    )
    status: Mapped[str] = mapped_column(Text)
    subject: Mapped[str] = mapped_column(Text)
    body: Mapped[str] = mapped_column(Text)
    customer_id: Mapped[Optional[str]] = mapped_column(Text)
    category: Mapped[str] = mapped_column(Text)
    urgency: Mapped[str] = mapped_column(Text)
    confidence: Mapped[float] = mapped_column(Double)
    routing_target: Mapped[str] = mapped_column(Text)
    suggested_reply: Mapped[Optional[str]] = mapped_column(Text)
    kb_sources: Mapped[list] = mapped_column(
        JSONB, server_default=text("'[]'::jsonb")
    )
    needs_human_review: Mapped[bool] = mapped_column(Boolean)
    review_reason: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    # The name matches the index the raw-SQL setup created.
    __table_args__ = (Index("tickets_status_created_idx", "status", "created_at"),)
