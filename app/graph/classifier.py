from langchain_anthropic import ChatAnthropic
from langchain_core.prompts import ChatPromptTemplate

from app.config import settings
from app.usage import usage_callback
from app.models import ClassificationResult, GraphState

_prompt = ChatPromptTemplate.from_messages([
    ("system",
          "You are a support ticket classifier. Read the ticket and decide its "
     "category (billing, technical, account, shipping, or other) and "
     "urgency (low, medium, high, or critical). Use shipping for orders "
     "that are late, lost, damaged or undelivered, and for tracking "
     "questions; refunds and charges stay under billing. Give a "
     "confidence score between 0 and 1, and a short reasoning for your "
     "decision.\n\n"
     "Category definitions:\n"
     "- billing: payments, charges, refunds, invoices, and the subscription itself, "
     "including cancelling it.\n"
     "- account: signing in, passwords, two-factor authentication, account security "
     "and account access.\n"
     "- technical: errors, bugs, outages, performance problems and the API.\n"
     "- shipping: orders, deliveries, tracking, returns and wrong items.\n"
     "- other: anything that fits none of these, or a ticket too vague to tell what "
     "the problem is. Do not guess a category from a vague ticket.\n\n"
     "Urgency definitions:\n"
     "- critical: many users are affected, the service is down, or there is an urgent "
     "business deadline.\n"
     "- high: the customer cannot get into their account, or has been charged "
     "incorrectly.\n"
     "- medium: something is wrong, such as an order, a payment question or a feature, "
     "but it is not blocking access to the account.\n"
     "- low: a general question about how or when something works, with nothing "
     "currently wrong."),
    ("human", "Subject: {subject}\n\nBody: {body}"),
])

_llm = ChatAnthropic(model=settings.model_id, 
                    temperature=0, 
                    timeout=settings.llm_timeout_seconds,
                    max_tokens=settings.llm_max_tokens,
                    max_retries=settings.llm_max_retries,
    callbacks=[usage_callback])

_chain = _prompt | _llm.with_structured_output(ClassificationResult)


def classify(state: GraphState) -> GraphState:
    ticket = state["ticket"]

    result: ClassificationResult = _chain.invoke({
        "subject": ticket.subject,
        "body": ticket.body,
    })

    return {"classification": result}
