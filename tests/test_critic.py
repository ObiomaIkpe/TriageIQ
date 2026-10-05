import pytest

from app.graph import critic
from app.graph.critic import CritiqueResult, LOW_CONFIDENCE_THRESHOLD, critique
from app.models import Category, ClassificationResult, TicketIn, Urgency

NO_KB_TEXT = "No relevant knowledge base articles found."


class FakeChain:
    """Stands in for the prompt | llm | structured-output chain."""

    def __init__(self, result: CritiqueResult):
        self.result = result
        self.calls: list[dict] = []

    def invoke(self, inputs: dict) -> CritiqueResult:
        self.calls.append(inputs)
        return self.result


@pytest.fixture
def fake_chain(monkeypatch):
    chain = FakeChain(CritiqueResult(needs_human_review=False, reason=""))
    monkeypatch.setattr(critic, "_chain", chain)
    return chain


def make_state(confidence: float = 0.9, kb_context=None) -> dict:
    state = {
        "ticket": TicketIn(subject="Cannot log in", body="Account locked."),
        "classification": ClassificationResult(
            category=Category.account,
            urgency=Urgency.high,
            confidence=confidence,
            reasoning="test",
        ),
        "draft_reply": "Your lockout clears after 1 hour.",
    }
    if kb_context is not None:
        state["kb_context"] = kb_context
    return state


def test_low_confidence_flags_without_calling_llm(fake_chain):
    result = critique(make_state(confidence=0.5))

    assert result["needs_human_review"] is True
    assert result["review_reason"] == "Low classifier confidence."
    assert fake_chain.calls == []


def test_confidence_at_threshold_goes_to_llm(fake_chain):
    critique(make_state(confidence=LOW_CONFIDENCE_THRESHOLD))

    assert len(fake_chain.calls) == 1


def test_llm_clears_supported_reply(fake_chain):
    result = critique(make_state(kb_context=["Lockout clears after 1 hour."]))

    assert result["needs_human_review"] is False
    assert result["review_reason"] == ""


def test_llm_flag_and_reason_are_passed_through(fake_chain):
    fake_chain.result = CritiqueResult(
        needs_human_review=True, reason="Unsupported escalation promise."
    )

    result = critique(make_state())

    assert result["needs_human_review"] is True
    assert result["review_reason"] == "Unsupported escalation promise."


def test_kb_snippets_are_sent_to_the_llm(fake_chain):
    critique(make_state(kb_context=["Article A", "Article B"]))

    sent = fake_chain.calls[0]["kb_context"]
    assert "- Article A" in sent
    assert "- Article B" in sent


@pytest.mark.parametrize("kb_context", [None, []])
def test_missing_or_empty_kb_sends_fallback_text(fake_chain, kb_context):
    critique(make_state(kb_context=kb_context))

    assert fake_chain.calls[0]["kb_context"] == NO_KB_TEXT


def test_llm_receives_ticket_classification_and_draft(fake_chain):
    critique(make_state(confidence=0.95))

    sent = fake_chain.calls[0]
    assert sent["subject"] == "Cannot log in"
    assert sent["category"] == "account"
    assert sent["urgency"] == "high"
    assert sent["confidence"] == 0.95
    assert sent["draft_reply"] == "Your lockout clears after 1 hour."


def test_critique_keeps_existing_state(fake_chain):
    state = make_state()
    result = critique(state)

    assert result["ticket"] is state["ticket"]
    assert result["draft_reply"] == state["draft_reply"]