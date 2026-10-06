import pytest

from app.graph import reply_draft
from app.graph.reply_draft import draft_reply
from app.models import KbMatch, TicketIn

NO_KB_TEXT = "No relevant knowledge base articles found."

ARTICLE_A = KbMatch(topic="topic a", content="Article A", distance=0.2)
ARTICLE_B = KbMatch(topic="topic b", content="Article B", distance=0.4)


class FakeChain:
    def __init__(self, result):
        self.result = result
        self.calls = []

    def invoke(self, inputs):
        self.calls.append(inputs)
        return self.result


@pytest.fixture
def fake_chain(monkeypatch):
    chain = FakeChain("Drafted reply.")
    monkeypatch.setattr(reply_draft, "_chain", chain)
    return chain


def make_state(kb_context=None) -> dict:
    state = {"ticket": TicketIn(subject="Cannot log in", body="Account locked.")}
    if kb_context is not None:
        state["kb_context"] = kb_context
    return state


def test_draft_is_stored_in_state(fake_chain):
    result = draft_reply(make_state([ARTICLE_A]))

    assert result["draft_reply"] == "Drafted reply."


def test_kb_matches_are_sent_as_bullets_with_their_topic(fake_chain):
    draft_reply(make_state([ARTICLE_A, ARTICLE_B]))

    sent = fake_chain.calls[0]["kb_context"]
    assert "- [topic a] Article A" in sent
    assert "- [topic b] Article B" in sent


@pytest.mark.parametrize("kb_context", [None, []])
def test_missing_or_empty_kb_sends_fallback_text(fake_chain, kb_context):
    draft_reply(make_state(kb_context))

    assert fake_chain.calls[0]["kb_context"] == NO_KB_TEXT


def test_llm_receives_subject_and_body(fake_chain):
    draft_reply(make_state([ARTICLE_A]))

    sent = fake_chain.calls[0]
    assert sent["subject"] == "Cannot log in"
    assert sent["body"] == "Account locked."


def test_draft_returns_only_its_own_keys(fake_chain):
    result = draft_reply(make_state([ARTICLE_A]))

    assert set(result) == {"draft_reply"}