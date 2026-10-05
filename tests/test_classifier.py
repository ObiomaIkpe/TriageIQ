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


def test_classify_keeps_existing_state(fake_chain):
    state = make_state()

    result = classify(state)

    assert result["ticket"] is state["ticket"]