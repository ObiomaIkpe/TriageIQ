import pytest

from app.graph.router import route
from app.models import Category, ClassificationResult, TicketIn, Urgency


def make_state(category: Category, urgency: Urgency) -> dict:
    return {
        "ticket": TicketIn(subject="s", body="b"),
        "classification": ClassificationResult(
            category=category,
            urgency=urgency,
            confidence=0.9,
            reasoning="test",
        ),
    }


@pytest.mark.parametrize("category, expected", [
    (Category.billing, "billing-team"),
    (Category.technical, "technical-support"),
    (Category.account, "account-management"),
    (Category.shipping, "shipping-team"),
    (Category.other, "general-queue"),
])
@pytest.mark.parametrize("urgency", [Urgency.low, Urgency.medium])
def test_normal_urgency_routes_to_base_team(category, expected, urgency):
    result = route(make_state(category, urgency))
    assert result["routing_target"] == expected


@pytest.mark.parametrize("category, expected", [
    (Category.billing, "billing-team-urgent"),
    (Category.technical, "technical-support-urgent"),
    (Category.account, "account-management-urgent"),
    (Category.shipping, "shipping-team-urgent"),
    (Category.other, "general-queue-urgent"),
])
@pytest.mark.parametrize("urgency", [Urgency.high, Urgency.critical])
def test_high_urgency_adds_urgent_suffix(category, expected, urgency):
    result = route(make_state(category, urgency))
    assert result["routing_target"] == expected


def test_route_keeps_existing_state():
    state = make_state(Category.billing, Urgency.low)
    result = route(state)
    assert result["ticket"] is state["ticket"]
    assert result["classification"] is state["classification"]


def test_every_category_has_a_routing_entry():
    # Guards against adding a category and forgetting the router, which would
    # silently send those tickets to general-queue.
    from app.graph.router import ROUTING_MAP

    assert set(ROUTING_MAP) == set(Category)