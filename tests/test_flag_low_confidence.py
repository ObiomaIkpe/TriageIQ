from app.graph.flag_low_confidence import flag_low_confidence
from app.models import Category, ClassificationResult, TicketIn, Urgency


def make_state() -> dict:
    return {
        "ticket": TicketIn(subject="Cannot log in", body="Account locked."),
        "classification": ClassificationResult(
            category=Category.other,
            urgency=Urgency.low,
            confidence=0.4,
            reasoning="Unclear.",
        ),
    }


def test_flags_for_review_with_the_exact_reason():
    result = flag_low_confidence(make_state())

    assert result["needs_human_review"] is True
    assert result["review_reason"] == "Low classifier confidence."


def test_returns_only_its_own_keys():
    result = flag_low_confidence(make_state())

    assert set(result) == {"needs_human_review", "review_reason"}
