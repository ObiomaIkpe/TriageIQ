import pytest

from app.graph import critic
from app.graph.critic import CritiqueResult, critique
from app.models import Category, ClassificationResult, KbMatch, TicketIn, Urgency

_UNSET = object()
DEFAULT_KB = [
    KbMatch(topic="account lockout", content="Lockout clears after 1 hour.", distance=0.3)
]
ARTICLE_A = KbMatch(topic="topic a", content="Article A", distance=0.2)
ARTICLE_B = KbMatch(topic="topic b", content="Article B", distance=0.4)


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


def make_state(confidence: float = 0.9, kb_context=_UNSET) -> dict:
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
    if kb_context is _UNSET:
        state["kb_context"] = list(DEFAULT_KB)
    elif kb_context is not None:
        state["kb_context"] = kb_context
    return state


# --- deterministic flags: no LLM call ---------------------------------------

@pytest.mark.parametrize("kb_context", [None, []])
def test_no_kb_match_flags_without_calling_llm(fake_chain, kb_context):
    result = critique(make_state(kb_context=kb_context))

    assert result["needs_human_review"] is True
    assert result["review_reason"] == "No knowledge base match."
    assert fake_chain.calls == []


def test_kb_failure_flags_without_calling_llm(fake_chain):
    state = make_state(kb_context=[])
    state["kb_failed"] = True

    result = critique(state)

    assert result["needs_human_review"] is True
    assert result["review_reason"] == "Knowledge base unavailable."
    assert fake_chain.calls == []


def test_critic_does_not_judge_confidence_itself(fake_chain):
    # Low-confidence tickets are stopped by the graph before this node. If one
    # did arrive with a KB match, the critic would not flag it on confidence.
    result = critique(make_state(confidence=0.3))

    assert len(fake_chain.calls) == 1
    assert result["review_reason"] == ""


# --- LLM path ---------------------------------------------------------------

def test_kb_ok_flag_still_goes_to_llm(fake_chain):
    state = make_state()
    state["kb_failed"] = False

    critique(state)

    assert len(fake_chain.calls) == 1


def test_llm_clears_supported_reply(fake_chain):
    result = critique(make_state())

    assert result["needs_human_review"] is False
    assert result["review_reason"] == ""


def test_llm_flag_and_reason_are_passed_through(fake_chain):
    fake_chain.result = CritiqueResult(
        needs_human_review=True, reason="Claim not in the article."
    )

    result = critique(make_state())

    assert result["needs_human_review"] is True
    assert result["review_reason"] == "Claim not in the article."


def test_kb_matches_are_sent_to_the_llm_as_bullets_with_their_topic(fake_chain):
    critique(make_state(kb_context=[ARTICLE_A, ARTICLE_B]))

    sent = fake_chain.calls[0]["kb_context"]
    assert "- [topic a] Article A" in sent
    assert "- [topic b] Article B" in sent


def test_llm_receives_ticket_classification_and_draft(fake_chain):
    critique(make_state(confidence=0.95))

    sent = fake_chain.calls[0]
    assert sent["subject"] == "Cannot log in"
    assert sent["category"] == "account"
    assert sent["urgency"] == "high"
    assert sent["confidence"] == 0.95
    assert sent["draft_reply"] == "Your lockout clears after 1 hour."


def test_llm_path_returns_only_its_own_keys(fake_chain):
    result = critique(make_state())

    assert set(result) == {"needs_human_review", "review_reason"}


def test_deterministic_flag_path_returns_only_its_own_keys(fake_chain):
    result = critique(make_state(kb_context=[]))

    assert set(result) == {"needs_human_review", "review_reason"}