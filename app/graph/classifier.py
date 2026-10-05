from langchain_anthropic import ChatAnthropic
from langchain_core.prompts import ChatPromptTemplate

from app.config import settings
from app.models import ClassificationResult, GraphState

_prompt = ChatPromptTemplate.from_messages([
    ("system",
          "You are a support ticket classifier. Read the ticket and decide its "
     "category (billing, technical, account, shipping, or other) and "
     "urgency (low, medium, high, or critical). Use shipping for orders "
     "that are late, lost, damaged or undelivered, and for tracking "
     "questions; refunds and charges stay under billing. Give a "
     "confidence score between 0 and 1, and a short reasoning for your "
     "decision."),
    ("human", "Subject: {subject}\n\nBody: {body}"),
])

_llm = ChatAnthropic(model=settings.model_id, 
                    temperature=0, 
                    timeout=settings.llm_timeout_seconds,
                    max_retries=settings.llm_max_retries)

_chain = _prompt | _llm.with_structured_output(ClassificationResult)


def classify(state: GraphState) -> GraphState:
    ticket = state["ticket"]

    result: ClassificationResult = _chain.invoke({
        "subject": ticket.subject,
        "body": ticket.body,
    })

    return {**state, "classification": result}
