from enum import Enum
from typing import Optional, TypedDict

from pydantic import BaseModel, Field


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


class TriageResult(BaseModel):
    category: Category
    urgency: Urgency
    confidence: float
    routing_target: str
    suggested_reply: Optional[str] = None
    kb_sources: list[str] = Field(default_factory=list)
    needs_human_review: bool
    review_reason: Optional[str] = None


class GraphState(TypedDict, total=False):
    """Shared state passed between LangGraph nodes."""
    ticket: TicketIn
    classification: ClassificationResult
    routing_target: str
    kb_context: list[str]
    draft_reply: str
    needs_human_review: bool
    review_reason: str
    kb_context: list[str]
    kb_failed: bool