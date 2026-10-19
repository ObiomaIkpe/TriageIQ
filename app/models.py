from datetime import datetime
from enum import Enum
from typing import Literal, Optional, TypedDict

from pydantic import BaseModel, Field, model_validator


class Category(str, Enum):
    billing = "billing"
    technical = "technical"
    account = "account"
    shipping = "shipping"
    other = "other"


class Urgency(str, Enum):
    low = "low"
    medium = "medium"
    high = "high"
    critical = "critical"


class TicketIn(BaseModel):
    subject: str
    body: str
    customer_id: Optional[str] = None


class ClassificationResult(BaseModel):
    category: Category
    urgency: Urgency
    confidence: float = Field(ge=0.0, le=1.0)
    reasoning: str


class KbMatch(BaseModel):
    topic: str
    content: str
    distance: float


class TicketStatus(str, Enum):
    triaged = "triaged"
    pending_review = "pending_review"


class TriageResult(BaseModel):
    ticket_id: str
    category: Category
    urgency: Urgency
    confidence: float
    routing_target: str
    suggested_reply: Optional[str] = None
    kb_sources: list[KbMatch] = Field(default_factory=list)
    needs_human_review: bool
    review_reason: Optional[str] = None


class TicketRecord(TriageResult):
    status: TicketStatus
    subject: str
    body: str
    customer_id: Optional[str] = None
    created_at: datetime


class ReviewDecision(BaseModel):
    """A reviewer's decision about a ticket that was paused for human review."""

    action: Literal["approve", "edit", "reject"]
    edited_reply: Optional[str] = None
    note: Optional[str] = None

    @model_validator(mode="after")
    def _an_edit_needs_text(self):
        # Whitespace alone does not count as text. The value itself is kept as given.
        if self.action == "edit" and not (self.edited_reply or "").strip():
            raise ValueError("action 'edit' requires a non-empty edited_reply")
        return self


class GraphState(TypedDict, total=False):
    """Shared state passed between LangGraph nodes."""
    ticket: TicketIn
    classification: ClassificationResult
    routing_target: str
    draft_reply: str
    draft_truncated: bool
    needs_human_review: bool
    review_reason: str
    kb_context: list[KbMatch]
    kb_failed: bool
    # Written by the human_review node. The decision is kept as a plain dict (the
    # output of ReviewDecision.model_dump()), so it needs no CHECKPOINT_TYPES entry.
    review_decision: dict
    final_reply: Optional[str]