from langchain_anthropic import ChatAnthropic
from langchain_core.prompts import ChatPromptTemplate
from pydantic import BaseModel, Field

from app.config import settings
from app.models import GraphState

LOW_CONFIDENCE_THRESHOLD = 0.6


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

_llm = ChatAnthropic(model=settings.model_id, temperature=0)

_chain = _prompt | _llm.with_structured_output(CritiqueResult)


def critique(state: GraphState) -> GraphState:
    classification = state["classification"]

    # Cheap, deterministic check first: a low confidence score is an
    # automatic flag, no need to spend an LLM call to know that.
    if classification.confidence < LOW_CONFIDENCE_THRESHOLD:
        return {
            **state,
            "needs_human_review": True,
            "review_reason": "Low classifier confidence.",
        }

    ticket = state["ticket"]
    kb_context = state.get("kb_context", [])

    context_text = (
        "\n".join(f"- {snippet}" for snippet in kb_context)
        if kb_context else "No relevant knowledge base articles found."
    )

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
        **state,
        "needs_human_review": result.needs_human_review,
        "review_reason": result.reason,
    }