import pytest

from app.graph import classifier
from app.graph.classifier import classify
from app.models import Category, ClassificationResult, TicketIn, Urgency


class FakeChain:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def invoke(self, inputs):
        self.calls.append(inputs)
        return self.result


@pytest.fixture
def fake_chain(monkeypatch):
    chain = FakeChain(
        ClassificationResult(
            category=Category.account,
            urgency=Urgency.high,
            confidence=0.95,
            reasoning="Locked account.",
        )
    )
    monkeypatch.setattr(classifier, "_chain", chain)
    return chain


def make_state() -> dict:
    return {"ticket": TicketIn(subject="Cannot log in", body="Account locked.")}


def test_classification_is_stored_in_state(fake_chain):
    result = classify(make_state())

    assert result["classification"] is fake_chain.result
    assert result["classification"].category == Category.account


def test_llm_receives_subject_and_body(fake_chain):
    classify(make_state())

    assert fake_chain.calls == [
        {"subject": "Cannot log in", "body": "Account locked."}
    ]


def test_classify_returns_only_its_own_keys(fake_chain):
    result = classify(make_state())

    assert set(result) == {"classification"}

def prompt_system():
    return classifier._prompt.invoke({"subject": "S", "body": "B"}).to_messages()[0].content


def test_the_existing_instructions_are_still_there():
    assert prompt_system().startswith(
        "You are a support ticket classifier. Read the ticket and decide its "
        "category (billing, technical, account, shipping, or other) and "
        "urgency (low, medium, high, or critical). Use shipping for orders "
        "that are late, lost, damaged or undelivered, and for tracking "
        "questions; refunds and charges stay under billing. Give a "
        "confidence score between 0 and 1, and a short reasoning for your "
        "decision."
    )


def test_the_category_and_urgency_definitions_are_present_word_for_word():
    assert prompt_system().endswith(
        "\n\nCategory definitions:\n"
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
        "currently wrong."
    )


def test_every_defined_name_is_a_real_category_and_urgency():
    system = prompt_system()
    for category in Category:
        assert f"- {category.value}: " in system
    for urgency in Urgency:
        assert f"- {urgency.value}: " in system
