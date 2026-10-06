from langchain_anthropic import ChatAnthropic
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser

from app.config import settings
from app.graph.formatting import format_kb_context
from app.models import GraphState

_prompt = ChatPromptTemplate.from_messages([
    ("system",
     "You are a support agent drafting a reply to a customer ticket. "
     "Use the provided knowledge base context to ground your answer in "
     "facts — do not invent policies or details that aren't in the "
     "context. If the context doesn't cover the issue, write a reply "
     "that acknowledges the issue and says a specialist will follow up, "
     "rather than guessing. Keep the tone professional and concise."),
    ("human",
     "Ticket subject: {subject}\n"
     "Ticket body: {body}\n\n"
     "Knowledge base context:\n{kb_context}\n\n"
     "Draft a reply to the customer."),
])

_llm = ChatAnthropic(model=settings.model_id, 
                    temperature=0.3,
                    timeout=settings.llm_timeout_seconds,
                    max_retries=settings.llm_max_retries,)

_chain = _prompt | _llm | StrOutputParser()


def draft_reply(state: GraphState) -> GraphState:
    ticket = state["ticket"]
    kb_context = state.get("kb_context", [])

    context_text = (
        format_kb_context(kb_context)
        if kb_context else "No relevant knowledge base articles found."
    )

    reply = _chain.invoke({
        "subject": ticket.subject,
        "body": ticket.body,
        "kb_context": context_text,
    })

    return {"draft_reply": reply}