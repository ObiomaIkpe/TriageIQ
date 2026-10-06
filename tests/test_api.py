import pytest
from fastapi.testclient import TestClient

from app.api import triage as triage_api
from app.graph import classifier, critic, kb_retrieval, reply_draft
from app.graph.critic import CritiqueResult
from app.main import app
from app.models import Category, ClassificationResult, KbMatch, Urgency

client = TestClient(app)

TICKET = {"subject": "Cannot log in", "body": "Account locked."}

KB_MATCH = KbMatch(
    topic="account lockout",
    content="Lockout clears automatically after 1 hour.",
    distance=0.33,
)
KB_MATCH_JSON = {
    "topic": "account lockout",
    "content": "Lockout clears automatically after 1 hour.",
    "distance": 0.33,
}


class FakeChain:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def invoke(self, inputs):
        self.calls.append(inputs)
        return self.result


@pytest.fixture
def fakes(monkeypatch):
    """Fake every outside call. The graph, router and API mapping run for real."""

    class Fakes:
        pass

    f = Fakes()
    f.classify = FakeChain(
        ClassificationResult(
            category=Category.account,
            urgency=Urgency.high,
            confidence=0.95,
            reasoning="Locked account.",
        )
    )
    f.draft = FakeChain("Your lockout clears after 1 hour.")
    f.critic = FakeChain(CritiqueResult(needs_human_review=False, reason=""))
    f.kb_results = [KB_MATCH]

    monkeypatch.setattr(classifier, "_chain", f.classify)
    monkeypatch.setattr(reply_draft, "_chain", f.draft)
    monkeypatch.setattr(critic, "_chain", f.critic)
    f.kb_error = None
    f.kb_calls = []

    def _search(query_text, top_k):
        f.kb_calls.append({"query_text": query_text, "top_k": top_k})
        if f.kb_error:
            raise f.kb_error
        return f.kb_results

    monkeypatch.setattr(kb_retrieval, "search_similar", _search)
    return f


def test_health():
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_grounded_ticket_is_triaged_and_not_flagged(fakes):
    response = client.post("/triage", json=TICKET)

    assert response.status_code == 200
    assert response.json() == {
        "category": "account",
        "urgency": "high",
        "confidence": 0.95,
        "routing_target": "account-management-urgent",
        "suggested_reply": "Your lockout clears after 1 hour.",
        "kb_sources": [KB_MATCH_JSON],
        "needs_human_review": False,
        "review_reason": None,
    }


def test_ticket_with_no_kb_match_is_flagged_by_rule_without_calling_critic(fakes):
    fakes.kb_results = []

    body = client.post("/triage", json=TICKET).json()

    assert body["kb_sources"] == []
    assert body["needs_human_review"] is True
    assert body["review_reason"] == "No knowledge base match."
    assert fakes.critic.calls == []


def test_critic_llm_can_flag_a_ticket_that_has_a_kb_match(fakes):
    fakes.critic.result = CritiqueResult(
        needs_human_review=True, reason="Reply adds a claim not in the article."
    )

    body = client.post("/triage", json=TICKET).json()

    assert body["kb_sources"] == [KB_MATCH_JSON]
    assert body["needs_human_review"] is True
    assert body["review_reason"] == "Reply adds a claim not in the article."


def test_low_confidence_ticket_skips_kb_draft_and_critic(fakes):
    fakes.classify.result = ClassificationResult(
        category=Category.other,
        urgency=Urgency.low,
        confidence=0.4,
        reasoning="Unclear.",
    )

    response = client.post("/triage", json=TICKET)

    assert response.status_code == 200
    body = response.json()
    assert body["suggested_reply"] is None
    assert body["kb_sources"] == []
    assert body["needs_human_review"] is True
    assert body["review_reason"] == "Low classifier confidence."
    assert fakes.kb_calls == []
    assert fakes.draft.calls == []
    assert fakes.critic.calls == []


def test_each_llm_node_runs_once_per_ticket(fakes):
    client.post("/triage", json=TICKET)

    assert len(fakes.classify.calls) == 1
    assert len(fakes.draft.calls) == 1
    assert len(fakes.critic.calls) == 1


def test_confident_ticket_still_calls_kb_draft_and_critic_once(fakes):
    client.post("/triage", json=TICKET)

    assert len(fakes.kb_calls) == 1
    assert len(fakes.draft.calls) == 1
    assert len(fakes.critic.calls) == 1


@pytest.mark.parametrize("payload", [
    {"subject": "No body"},
    {"body": "No subject"},
    {},
])
def test_invalid_ticket_is_rejected_with_422(fakes, payload):
    response = client.post("/triage", json=payload)

    assert response.status_code == 422
    assert fakes.classify.calls == []


def test_kb_failure_degrades_and_flags_for_review(fakes):
    fakes.kb_error = RuntimeError("database is down")

    response = client.post("/triage", json=TICKET)

    assert response.status_code == 200
    body = response.json()
    assert body["kb_sources"] == []
    assert body["suggested_reply"] == "Your lockout clears after 1 hour."
    assert body["needs_human_review"] is True
    assert body["review_reason"] == "Knowledge base unavailable."
    assert fakes.critic.calls == []


def test_missing_state_field_fails_loudly_instead_of_defaulting(monkeypatch):
    class PartialGraph:
        def invoke(self, state):
            return {
                "classification": ClassificationResult(
                    category=Category.account,
                    urgency=Urgency.low,
                    confidence=0.9,
                    reasoning="test",
                )
            }

    monkeypatch.setattr(triage_api, "triage_graph", PartialGraph())

    response = TestClient(app, raise_server_exceptions=False).post(
        "/triage", json=TICKET
    )

    assert response.status_code == 500