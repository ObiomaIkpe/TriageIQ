from langchain_anthropic import ChatAnthropic
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel, Field

from app.config import settings
from app.graph.formatting import format_kb_context
from app.graph.kb_grader import INJECTION_REASON, REJECTED_REASON, UNAVAILABLE_REASON
from app.models import GraphState


class CritiqueResult(BaseModel):
    needs_human_review: bool
    reason: str = Field(description="Empty string if no review is needed.")


_prompt = ChatPromptTemplate.from_messages([
    ("system",
     "You are reviewing a support agent's classification and draft reply "
     "before it's sent. Flag needs_human_review=true if: the draft reply "
     "seems inconsistent with the ticket, the reply makes claims not "
     "supported by the knowledge base context, or the classification "
     "seems wrong given the ticket content. Otherwise false."),
    ("human",
     "Ticket subject: {subject}\n"
     "Ticket body: {body}\n\n"
     "Classification: category={category}, urgency={urgency}, "
     "confidence={confidence}\n\n"
     "Knowledge base context:\n{kb_context}\n\n"
     "Draft reply: {draft_reply}"),
])

_llm = ChatAnthropic(
    model=settings.model_id,
    temperature=0,
    timeout=settings.llm_timeout_seconds,
    max_tokens=settings.llm_max_tokens,
    max_retries=settings.llm_max_retries,
)

_chain = _prompt | _llm.with_structured_output(CritiqueResult)


def critique(state: GraphState) -> GraphState:
    classification = state["classification"]
    kb_context = state.get("kb_context", [])

    # Deterministic checks first. Each one flags the ticket for a human without
    # spending an LLM call, and the same ticket always gets the same verdict.
    # Low classifier confidence is not checked here: the graph sends those
    # tickets to flag_low_confidence and they never reach this node.
    # Suspected prompt injection comes first and stands alone: it overrides every other
    # reason, and like the rule checks below it flags the ticket without a Claude call.
    if (state.get("kb_grade") or {}).get("injection_suspected"):
        return {
            "needs_human_review": True,
            "review_reason": INJECTION_REASON,
        }

    reasons = []
    if state.get("kb_failed"):
        reasons.append("Knowledge base unavailable.")
    elif not kb_context:
        # Empty context after the grader ran has its own reason; with no grade it is a
        # plain retrieval miss.
        grade_status = (state.get("kb_grade") or {}).get("status")
        reasons.append({
            "rejected": REJECTED_REASON,
            "unavailable": UNAVAILABLE_REASON,
        }.get(grade_status, "No knowledge base match."))
    # The drafter ran out of room (LLM_MAX_TOKENS), so the reply stops mid-sentence.
    # There is nothing for the LLM critic to review, so a human has to.
    if state.get("draft_truncated"):
        reasons.append("Draft reply was cut off at the token limit.")

    if reasons:
        return {
            "needs_human_review": True,
            "review_reason": " ".join(reasons),
        }

    # Only tickets with a KB match reach the LLM critic, so kb_context is
    # never empty here.
    ticket = state["ticket"]
    context_text = format_kb_context(kb_context)

    result: CritiqueResult = _chain.invoke({
        "subject": ticket.subject,
        "body": ticket.body,
        "category": classification.category.value,
        "urgency": classification.urgency.value,
        "confidence": classification.confidence,
        "kb_context": context_text,
        "draft_reply": state.get("draft_reply", ""),
    })

    return {
        "needs_human_review": result.needs_human_review,
        "review_reason": result.reason,
    }