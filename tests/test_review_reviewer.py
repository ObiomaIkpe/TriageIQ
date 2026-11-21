"""The reviewer in POST /tickets/{id}/review, without a database.

The database layers (session, row lock, graph resume, record_review) are replaced by fakes that
record what they receive, so these tests are about what the endpoint accepts and passes on.
"""
from contextlib import contextmanager
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.api import review as review_api
from app.config import settings
from app.main import app
from app.models import (
    Category,
    ReviewDecision,
    ReviewedBy,
    ReviewRequest,
    Reviewer,
    TicketRecord,
    TicketStatus,
    Urgency,
)

client = TestClient(app)
KEY = "dummy-review-key"
TICKET_ID = "12345678-1234-5678-1234-567812345678"
URL = f"/tickets/{TICKET_ID}/review"
HEADERS = {"X-API-Key": KEY}
USER_ID = "user:3f6b2c1e-8a4d-4b7e-9c10-5d2e7a9b1f34"
REVIEWER = {"id": USER_ID, "name": "Ada Lovelace"}


def _record(status=TicketStatus.pending_review, reviewed_by=None):
    return TicketRecord(
        ticket_id=TICKET_ID,
        reference="TKT-ABC234",
        status=status,
        subject="s",
        body="b",
        category=Category.account,
        urgency=Urgency.low,
        confidence=0.9,
        routing_target="general-queue",
        needs_human_review=True,
        created_at=datetime(2026, 10, 19, tzinfo=timezone.utc),
        reviewed_by=reviewed_by,
    )


@pytest.fixture
def wired(monkeypatch):
    """The endpoint with fakes underneath. `seen` records what reached each layer."""
    monkeypatch.setattr(settings, "review_api_key", KEY)
    seen = {"session": 0, "resume": [], "record": []}

    @contextmanager
    def fake_session():
        seen["session"] += 1
        yield object()

    def fake_record(session, ticket_id, decision, final_reply, reviewer):
        seen["record"].append((ticket_id, decision, final_reply, reviewer))
        return _record(
            status=TicketStatus.edited, reviewed_by=ReviewedBy(id=reviewer.id, name=reviewer.name)
        )

    monkeypatch.setattr(review_api, "get_session", fake_session)
    monkeypatch.setattr(review_api, "get_ticket_for_update", lambda session, ticket_id: _record())
    monkeypatch.setattr(
        review_api,
        "resume_review",
        lambda graph, ticket_id, decision: seen["resume"].append(decision) or {"final_reply": "x"},
    )
    monkeypatch.setattr(review_api, "record_review", fake_record)
    return seen


def post(body, headers=HEADERS):
    return client.post(URL, json=body, headers=headers)


# --- what is accepted ---------------------------------------------------------------------

def test_a_review_with_a_reviewer_is_stored_with_that_reviewer(wired):
    response = post({"action": "edit", "edited_reply": "hi", "reviewer": REVIEWER})

    assert response.status_code == 200
    assert wired["record"][0][3] == Reviewer(id=USER_ID, name="Ada Lovelace")
    assert response.json()["reviewed_by"] == {"id": USER_ID, "name": "Ada Lovelace"}


def test_the_graph_is_resumed_with_the_decision_only_never_the_reviewer(wired):
    post({"action": "edit", "edited_reply": "hi", "note": "n", "reviewer": REVIEWER})

    (decision,) = wired["resume"]
    assert type(decision) is ReviewDecision  # not ReviewRequest
    assert decision.model_dump() == {"action": "edit", "edited_reply": "hi", "note": "n"}
    assert "reviewer" not in decision.model_dump()


@pytest.mark.parametrize("name", ["Ọbiọma Ụzọ", "Zoë Ångström", "李小龍", "Ada 👩‍💻 L", "x"])
def test_any_unicode_name_round_trips(wired, name):
    response = post({"action": "approve", "reviewer": {"id": "client:ops", "name": name}})

    assert response.status_code == 200
    assert wired["record"][0][3].name == name
    assert response.json()["reviewed_by"]["name"] == name


def test_the_name_is_trimmed(wired):
    post({"action": "approve", "reviewer": {"id": "client:ops", "name": "  Ọbiọma Ụzọ \n"}})
    assert wired["record"][0][3].name == "Ọbiọma Ụzọ"


def test_a_100_character_name_is_fine(wired):
    assert post({"action": "approve", "reviewer": {"id": "client:ops", "name": "ọ" * 100}}).status_code == 200


@pytest.mark.parametrize("reviewer_id", [USER_ID, "client:ops", "client:a", "client:" + "a" * 40, "client:my-client-2"])
def test_valid_reviewer_ids(wired, reviewer_id):
    assert post({"action": "approve", "reviewer": {"id": reviewer_id, "name": "N"}}).status_code == 200


# --- what is refused: 422, and nothing is touched -----------------------------------------

BAD_BODIES = [
    pytest.param({"action": "approve"}, id="no reviewer at all"),
    pytest.param({"action": "approve", "reviewer": None}, id="reviewer null"),
    pytest.param({"action": "approve", "reviewer": "client:ops"}, id="reviewer a string"),
    pytest.param({"action": "approve", "reviewer": {}}, id="empty reviewer"),
    pytest.param({"action": "approve", "reviewer": {"id": "client:ops"}}, id="no name"),
    pytest.param({"action": "approve", "reviewer": {"name": "Ada"}}, id="no id"),
    pytest.param({"action": "approve", "reviewer": {"id": "admin", "name": "Ada"}}, id="id: admin"),
    pytest.param({"action": "approve", "reviewer": {"id": "user:not-a-uuid", "name": "Ada"}}, id="id: user:not-a-uuid"),
    pytest.param({"action": "approve", "reviewer": {"id": "client:UPPER", "name": "Ada"}}, id="id: client:UPPER"),
    pytest.param({"action": "approve", "reviewer": {"id": "client:", "name": "Ada"}}, id="id: client: (empty)"),
    pytest.param({"action": "approve", "reviewer": {"id": "client:" + "a" * 41, "name": "Ada"}}, id="id: 41-char client"),
    pytest.param({"action": "approve", "reviewer": {"id": "client:has space", "name": "Ada"}}, id="id: with a space"),
    pytest.param({"action": "approve", "reviewer": {"id": "client:under_score", "name": "Ada"}}, id="id: underscore"),
    pytest.param({"action": "approve", "reviewer": {"id": USER_ID.upper(), "name": "Ada"}}, id="id: upper-case uuid"),
    pytest.param({"action": "approve", "reviewer": {"id": USER_ID + "x", "name": "Ada"}}, id="id: uuid with a tail"),
    pytest.param({"action": "approve", "reviewer": {"id": USER_ID + "\n", "name": "Ada"}}, id="id: uuid with a newline"),
    pytest.param({"action": "approve", "reviewer": {"id": "client:ops\n", "name": "Ada"}}, id="id: client with a newline"),
    pytest.param({"action": "approve", "reviewer": {"id": "xuser:" + USER_ID[5:], "name": "Ada"}}, id="id: wrong prefix"),
    pytest.param({"action": "approve", "reviewer": {"id": 5, "name": "Ada"}}, id="id not a string"),
    pytest.param({"action": "approve", "reviewer": {"id": "client:ops", "name": ""}}, id="empty name"),
    pytest.param({"action": "approve", "reviewer": {"id": "client:ops", "name": "   \t\n"}}, id="whitespace-only name"),
    pytest.param({"action": "approve", "reviewer": {"id": "client:ops", "name": "x" * 101}}, id="101-character name"),
    pytest.param({"action": "approve", "reviewer": {"id": "client:ops", "name": "ọ" * 101}}, id="101 non-ASCII characters"),
    pytest.param({"action": "approve", "reviewer": {"id": "client:ops", "name": 5}}, id="name not a string"),
    pytest.param({"action": "approve", "reviewer": {"id": "client:ops", "name": None}}, id="name null"),
]


@pytest.mark.parametrize("body", BAD_BODIES)
def test_a_missing_or_invalid_reviewer_is_422_and_nothing_is_touched(wired, body):
    response = post(body)

    assert response.status_code == 422
    assert wired == {"session": 0, "resume": [], "record": []}  # no transaction, no graph, no write


def test_the_key_is_still_checked_first(wired):
    # no key: 401 even though the reviewer is missing (the key check runs before the body is read)
    assert client.post(URL, json={"action": "approve"}).status_code == 401
    assert client.post(URL, json={"action": "approve"}, headers={"X-API-Key": "nope"}).status_code == 401


def test_the_decision_rules_still_apply_with_a_reviewer(wired):
    assert post({"action": "edit", "reviewer": REVIEWER}).status_code == 422  # an edit needs text
    assert post({"action": "delete", "reviewer": REVIEWER}).status_code == 422
    assert wired["record"] == []


# --- the models ---------------------------------------------------------------------------

def test_a_review_request_is_a_decision_plus_a_reviewer():
    request = ReviewRequest(action="approve", reviewer=Reviewer(id="client:ops", name=" ops "))
    assert request.reviewer.name == "ops"
    assert request.action == "approve"


def test_the_plain_decision_model_is_unchanged_and_has_no_reviewer():
    assert "reviewer" not in ReviewDecision.model_fields
    ReviewDecision(action="approve")  # still valid on its own: the graph does not know reviewers


def test_reviewer_validation_errors_do_not_pass_silently():
    with pytest.raises(ValidationError):
        Reviewer(id="admin", name="x")
    with pytest.raises(ValidationError):
        Reviewer(id="client:ops", name=" ")


def test_the_endpoint_comment_explains_why_the_reviewer_is_trusted():
    from pathlib import Path

    source = Path(review_api.__file__).read_text()
    assert "WHY THE REVIEWER IS TRUSTED" in source
    assert "service review key" in source and "only the gateway holds that key" in source


# --- reads --------------------------------------------------------------------------------

def test_a_ticket_read_shows_reviewed_by_or_null(monkeypatch):
    reviewed = _record(TicketStatus.edited, ReviewedBy(id="client:ops", name="ops"))
    monkeypatch.setattr(review_api, "get_ticket_by_reference", lambda ref: reviewed)
    assert client.get("/tickets/reference/TKT-ABC234").json()["reviewed_by"] == {"id": "client:ops", "name": "ops"}

    monkeypatch.setattr(review_api, "get_ticket_by_reference", lambda ref: _record())
    assert client.get("/tickets/reference/TKT-ABC234").json()["reviewed_by"] is None
