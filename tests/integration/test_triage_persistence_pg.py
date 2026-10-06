"""POST /triage then GET /tickets against a real Postgres.

Claude and the KB search are faked (no API keys, no Voyage); everything else,
including the database, is real.
"""
import pytest
from fastapi.testclient import TestClient

from app.graph import classifier, critic, kb_retrieval, reply_draft
from app.graph.critic import CritiqueResult
from app.main import app
from app.models import Category, ClassificationResult, KbMatch, Urgency

pytestmark = pytest.mark.integration

client = TestClient(app)
TICKET = {"subject": "Cannot log in", "body": "Account locked.", "customer_id": "cust-1"}
KB_MATCH = KbMatch(
    topic="account lockout",
    content="Lockout clears automatically after 1 hour.",
    distance=0.33,
)


class FakeChain:
    def __init__(self, result):
        self.result = result

    def invoke(self, inputs):
        return self.result


@pytest.fixture
def fake_llm_and_kb(monkeypatch, test_session):
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
    f.critic = FakeChain(CritiqueResult(needs_human_review=False, reason=""))
    monkeypatch.setattr(classifier, "_chain", f.classify)
    monkeypatch.setattr(reply_draft, "_chain", FakeChain("Your lockout clears after 1 hour."))
    monkeypatch.setattr(critic, "_chain", f.critic)
    monkeypatch.setattr(kb_retrieval, "search_similar", lambda query_text, top_k: [KB_MATCH])
    return f


def test_a_triaged_ticket_is_saved_and_can_be_read_back(fake_llm_and_kb):
    posted = client.post("/triage", json=TICKET).json()

    fetched = client.get(f"/tickets/{posted['ticket_id']}")

    assert fetched.status_code == 200
    body = fetched.json()
    assert body["ticket_id"] == posted["ticket_id"]
    assert body["status"] == "triaged"
    assert body["subject"] == "Cannot log in"
    assert body["customer_id"] == "cust-1"
    assert body["routing_target"] == "account-management-urgent"
    assert body["suggested_reply"] == "Your lockout clears after 1 hour."
    assert body["kb_sources"] == [KB_MATCH.model_dump()]
    assert body["needs_human_review"] is False
    assert body["created_at"]


def test_the_ticket_appears_in_the_list(fake_llm_and_kb):
    posted = client.post("/triage", json=TICKET).json()

    listed = client.get("/tickets").json()

    assert [t["ticket_id"] for t in listed] == [posted["ticket_id"]]


def test_a_low_confidence_ticket_is_saved_without_a_reply_and_pending_review(fake_llm_and_kb):
    fake_llm_and_kb.classify.result = ClassificationResult(
        category=Category.other, urgency=Urgency.low, confidence=0.4, reasoning="Unclear.",
    )

    posted = client.post("/triage", json=TICKET).json()
    saved = client.get(f"/tickets/{posted['ticket_id']}").json()

    assert saved["status"] == "pending_review"
    assert saved["suggested_reply"] is None
    assert saved["kb_sources"] == []
    assert saved["review_reason"] == "Low classifier confidence."


def test_a_critic_flagged_ticket_shows_up_under_the_pending_review_filter(fake_llm_and_kb):
    fake_llm_and_kb.critic.result = CritiqueResult(
        needs_human_review=True, reason="Reply adds a claim not in the article."
    )

    posted = client.post("/triage", json=TICKET).json()

    pending = client.get("/tickets", params={"status": "pending_review"}).json()
    triaged = client.get("/tickets", params={"status": "triaged"}).json()
    assert [t["ticket_id"] for t in pending] == [posted["ticket_id"]]
    assert triaged == []


def test_a_failed_triage_saves_nothing(fake_llm_and_kb, monkeypatch):
    class Boom:
        def invoke(self, inputs):
            raise ValueError("a real bug")

    monkeypatch.setattr(classifier, "_chain", Boom())

    response = TestClient(app, raise_server_exceptions=False).post("/triage", json=TICKET)

    assert response.status_code == 500
    assert client.get("/tickets").json() == []


def test_an_unknown_ticket_id_is_a_404(fake_llm_and_kb):
    response = client.get("/tickets/12345678-1234-5678-1234-567812345678")

    assert response.status_code == 404
    assert response.json() == {"detail": "Ticket not found"}
