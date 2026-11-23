import logging

from langchain_anthropic import ChatAnthropic
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

from app.config import settings
from app.usage import usage_callback
from app.graph.formatting import format_kb_context
from app.models import GraphState

logger = logging.getLogger(__name__)

# Claude's stop reason when it ran out of room before it finished the answer.
TRUNCATED_STOP_REASON = "max_tokens"

_prompt = ChatPromptTemplate.from_messages([
    ("system",
     "You are a support agent drafting a reply to a customer ticket. "
     "Use the provided knowledge base context to ground your answer in "
     "facts — do not invent policies or details that aren't in the "
     "context. If the context doesn't cover the issue, write a reply "
     "that acknowledges the issue and says a specialist will follow up, "
     "rather than guessing. Keep the tone professional and concise.\n\n"
     "Rules for every reply:\n"
     "1. Use only facts stated in the knowledge base articles provided. Do not add "
     "tips, troubleshooting steps, procedures, timeframes or policies from general "
     "knowledge, even if they seem helpful. If the customer asks about something the "
     "articles do not cover, say that a member of the team will follow up on that "
     "part, and do not guess.\n"
     "2. You cannot see or change the customer's account. Never claim to have checked, "
     "seen, confirmed, processed or changed anything on their account, and never state "
     "the account's current status as fact. You may refer to what the customer told "
     "you, as their statement, for example \"You mentioned that...\".\n"
     "3. Never include placeholders, bracketed text, template markers or notes to "
     "staff. Every sentence must be ready to send to the customer as written. If a "
     "detail is missing from the articles, leave it out rather than marking where it "
     "would go."),
    ("human",
     "Ticket subject: {subject}\n"
     "Ticket body: {body}\n\n"
     "Knowledge base context:\n{kb_context}\n\n"
     "Draft a reply to the customer."),
])

_llm = ChatAnthropic(model=settings.model_id, 
                    temperature=0.3,
                    timeout=settings.llm_timeout_seconds,
                    max_tokens=settings.llm_max_tokens,
                    max_retries=settings.llm_max_retries,
    callbacks=[usage_callback])

# The chain returns Claude's whole message, not just its text, because the
# message also says why Claude stopped (see draft_reply). The text is taken out
# of it afterwards with the same StrOutputParser the chain used to end with.
_chain = _prompt | _llm
_to_text = StrOutputParser()


def draft_reply(state: GraphState) -> GraphState:
    ticket = state["ticket"]
    kb_context = state.get("kb_context", [])

    context_text = (
        format_kb_context(kb_context)
        if kb_context else "No relevant knowledge base articles found."
    )

    message = _chain.invoke({
        "subject": ticket.subject,
        "body": ticket.body,
        "kb_context": context_text,
    })
    reply = _to_text.invoke(message)

    # If Claude ran out of room, the reply stops mid-sentence. Record that, so the
    # critic can send the ticket to a human instead of treating it as finished.
    stop_reason = message.response_metadata.get("stop_reason")
    output_tokens = (getattr(message, "usage_metadata", None) or {}).get("output_tokens")
    truncated = stop_reason == TRUNCATED_STOP_REASON
    if truncated:
        logger.warning(
            "Draft reply was cut off at the token limit "
            "(stop_reason=%s, output_tokens=%s, max_tokens=%s)",
            stop_reason, output_tokens, settings.llm_max_tokens,
        )
    else:
        logger.info(
            "Draft reply written (stop_reason=%s, output_tokens=%s)",
            stop_reason, output_tokens,
        )

    return {"draft_reply": reply, "draft_truncated": truncated}