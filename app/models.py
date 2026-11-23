from datetime import datetime
from enum import Enum
from typing import Annotated, Literal, Optional, TypedDict
from uuid import UUID

from pydantic import BaseModel, Field, StringConstraints, model_validator

from app.tickets.reference import REFERENCE_PATTERN


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
    # Optional idempotency key. When given, it becomes the ticket's id and the run's
    # thread id, and the same id can be sent again without triaging or saving twice.
    ticket_id: Optional[UUID] = None
    # Optional ticket reference (TKT-XXXXXX), made by the gateway at accept time. When given, it is
    # the ticket's reference; when absent Python makes one, as before. A supplied reference that
    # already belongs to a DIFFERENT ticket is a 409 (code reference_conflict), never a silent change.
    reference: Optional[str] = Field(default=None, pattern=REFERENCE_PATTERN)
    # Who wrote in, from the public form. Stored and shown to reviewers, but NEVER sent to the model:
    # the graph is run with a copy of the ticket that has these removed (see app/api/triage.py).
    customer_name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    customer_email: Optional[str] = Field(default=None, min_length=1, max_length=254)


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
    approved = "approved"
    edited = "edited"
    rejected = "rejected"


class TriageResult(BaseModel):
    ticket_id: str
    reference: str
    category: Category
    urgency: Urgency
    confidence: float
    routing_target: str
    suggested_reply: Optional[str] = None
    kb_sources: list[KbMatch] = Field(default_factory=list)
    needs_human_review: bool
    review_reason: Optional[str] = None


class ReviewedBy(BaseModel):
    """Who decided a reviewed ticket, as stored: the id and the name AT THE TIME of the review."""

    id: str
    name: str


class TicketRecord(TriageResult):
    status: TicketStatus
    subject: str
    body: str
    customer_id: Optional[str] = None
    created_at: datetime
    final_reply: Optional[str] = None
    review_note: Optional[str] = None
    reviewed_at: Optional[datetime] = None
    # None for a ticket not reviewed yet, and for one reviewed before reviewers were recorded.
    reviewed_by: Optional[ReviewedBy] = None
    # From the public form; None for tickets that came in through an API client.
    customer_name: Optional[str] = None
    customer_email: Optional[str] = None
    # Token usage per provider and an ESTIMATED cost in US dollars (see app/usage.py). Shown to reviewers only.
    # None for tickets saved before this existed.
    ai_usage: Optional[dict] = None
    ai_cost_usd: Optional[float] = None


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


# "user:<uuid>" for a logged-in reviewer, "client:<name>" for a machine client (a gateway API client).
REVIEWER_ID_PATTERN = (
    r"^(user:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|client:[a-z0-9-]{1,40})$"
)


class Reviewer(BaseModel):
    """Who is making a review decision. Sent by the gateway, never by an end client."""

    id: str = Field(pattern=REVIEWER_ID_PATTERN)
    # Trimmed, then 1 to 100 characters. Any Unicode: names are not limited to ASCII.
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


class ReviewRequest(ReviewDecision):
    """The body of POST /tickets/{id}/review: the decision plus who is making it.

    ReviewDecision stays exactly as it was: it is what the graph resumes with, and the reviewer is
    not part of the graph's state. Only the endpoint sees the reviewer.
    """

    reviewer: Reviewer


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
    # Written by the kb_grader node: {"relevant_topics": [...], "reason": str, "status":
    # "ok" | "rejected" | "unavailable"}. A plain dict, so it needs no CHECKPOINT_TYPES entry.
    kb_grade: dict
    # Written by the human_review node. The decision is kept as a plain dict (the
    # output of ReviewDecision.model_dump()), so it needs no CHECKPOINT_TYPES entry.
    review_decision: dict
    final_reply: Optional[str]