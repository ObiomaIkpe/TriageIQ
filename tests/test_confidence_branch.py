import pytest

from app.config import settings
from app.graph.build import route_by_confidence
from app.models import Category, ClassificationResult, TicketIn, Urgency


def make_state(confidence: float) -> dict:
    return {
        "ticket": TicketIn(subject="s", body="b"),
        "classification": ClassificationResult(
            category=Category.account,
            urgency=Urgency.low,
            confidence=confidence,
            reasoning="test",
        ),
    }


@pytest.mark.parametrize("confidence, expected", [
    (0.59, "flag_low_confidence"),
    (0.6, "retrieve_kb"),
    (0.95, "retrieve_kb"),
])
def test_branch_examples(confidence, expected):
    assert route_by_confidence(make_state(confidence)) == expected


def test_exactly_the_threshold_counts_as_confident():
    state = make_state(settings.low_confidence_threshold)

    assert route_by_confidence(state) == "retrieve_kb"


def test_just_below_the_threshold_is_low_confidence():
    state = make_state(settings.low_confidence_threshold - 0.01)

    assert route_by_confidence(state) == "flag_low_confidence"


def test_branch_follows_the_setting(monkeypatch):
    monkeypatch.setattr(settings, "low_confidence_threshold", 0.8)

    assert route_by_confidence(make_state(0.7)) == "flag_low_confidence"
    assert route_by_confidence(make_state(0.8)) == "retrieve_kb"


def make_other_state(confidence: float, category=Category.other) -> dict:
    state = make_state(confidence)
    state["classification"].category = category
    return state


@pytest.mark.parametrize("confidence", [0.0, 0.59, 0.6, 0.95, 1.0])
def test_category_other_always_goes_to_the_flag_node(confidence):
    assert route_by_confidence(make_other_state(confidence)) == "flag_low_confidence"


@pytest.mark.parametrize("category", [c for c in Category if c != Category.other])
def test_every_other_category_still_branches_on_confidence(category):
    assert route_by_confidence(make_other_state(0.95, category)) == "retrieve_kb"
    assert route_by_confidence(make_other_state(0.2, category)) == "flag_low_confidence"
