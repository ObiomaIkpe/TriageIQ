from langchain_anthropic import ChatAnthropic
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import PydanticOutputParser

from app.models import ClassificationResult, GraphState

_parser = PydanticOutputParser(pydantic_object=ClassificationResult)

_prompt = ChatPromptTemplate.from_messages([
    ("system",
     "You are a support ticket classifier. Read the ticket and decide its "
     "category (billing, technical, account, or other) and urgency "
     "(low, medium, high, or critical). Give a confidence score between "
     "0 and 1, and a short reasoning for your decision.\n\n"
     "{format_instructions}"),
    ("human", "Subject: {subject}\n\nBody: {body}"),
])

_llm = ChatAnthropic(model="claude-sonnet-4-6", temperature=0)

_chain = _prompt | _llm | _parser


def classify(state: GraphState) -> GraphState:
    ticket = state["ticket"]

    result: ClassificationResult = _chain.invoke({
        "subject": ticket.subject,
        "body": ticket.body,
        "format_instructions": _parser.get_format_instructions(),
    })

    return {**state, "classification": result}