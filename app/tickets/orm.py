import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Boolean, CheckConstraint, DateTime, Double, Index, Text, UniqueConstraint, func, text
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
    reference: Mapped[str] = mapped_column(Text)
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
    final_reply: Mapped[Optional[str]] = mapped_column(Text)
    review_note: Mapped[Optional[str]] = mapped_column(Text)
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    # Who decided, as a snapshot at review time. Both NULL for tickets reviewed before this existed.
    reviewed_by_id: Mapped[Optional[str]] = mapped_column(Text)
    reviewed_by_name: Mapped[Optional[str]] = mapped_column(Text)
    # Who wrote in (public form only). Never part of what the model sees.
    customer_name: Mapped[Optional[str]] = mapped_column(Text)
    customer_email: Mapped[Optional[str]] = mapped_column(Text)
    # What the model calls for this ticket used, and an ESTIMATED cost (app/usage.py). NULL for tickets
    # saved before this existed, and when no call was counted.
    ai_usage: Mapped[Optional[dict]] = mapped_column(JSONB)
    ai_cost_usd: Mapped[Optional[float]] = mapped_column(Double)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        # The name matches the index the raw-SQL setup created.
        Index("tickets_status_created_idx", "status", "created_at"),
        UniqueConstraint("reference", name="tickets_reference_key"),
        # A review is saved with its author or not at all: the two columns are both set or both NULL.
        CheckConstraint(
            "(reviewed_by_id IS NULL) = (reviewed_by_name IS NULL)",
            name="tickets_reviewed_by_both_or_neither",
        ),
    )
