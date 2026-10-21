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


def state_with(category, confidence):
    state = make_state()
    state["classification"] = ClassificationResult(
        category=category, urgency=Urgency.low, confidence=confidence, reasoning="r",
    )
    return state


def test_other_with_high_confidence_gets_the_uncategorised_reason():
    result = flag_low_confidence(state_with(Category.other, 0.95))

    assert result == {"needs_human_review": True,
                      "review_reason": "Ticket could not be categorised."}


def test_low_confidence_wins_when_both_apply():
    result = flag_low_confidence(state_with(Category.other, 0.4))

    assert result["review_reason"] == "Low classifier confidence."


def test_exactly_the_threshold_is_not_low_confidence():
    from app.config import settings

    result = flag_low_confidence(state_with(Category.other, settings.low_confidence_threshold))

    assert result["review_reason"] == "Ticket could not be categorised."
