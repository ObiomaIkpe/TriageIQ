import pytest

from app.graph import reply_draft
from app.graph.reply_draft import draft_reply
from app.models import KbMatch, TicketIn
from tests.helpers import ai_message

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
    chain = FakeChain(ai_message("Drafted reply."))
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

    assert set(result) == {"draft_reply", "draft_truncated"}


# --- cut-off detection ------------------------------------------------------

def test_a_reply_that_finished_is_not_marked_truncated(fake_chain):
    result = draft_reply(make_state([ARTICLE_A]))

    assert result["draft_truncated"] is False


def test_a_reply_that_ran_out_of_room_is_marked_truncated(fake_chain):
    fake_chain.result = ai_message("Your account was locked because of too many failed log", "max_tokens")

    result = draft_reply(make_state([ARTICLE_A]))

    assert result["draft_truncated"] is True


def test_the_cut_off_text_is_still_returned_unchanged(fake_chain):
    cut = "Your account was locked because of too many failed log"
    fake_chain.result = ai_message(cut, "max_tokens")

    result = draft_reply(make_state([ARTICLE_A]))

    assert result["draft_reply"] == cut


@pytest.mark.parametrize("stop_reason", ["end_turn", "stop_sequence", "tool_use", None])
def test_only_max_tokens_counts_as_truncated(fake_chain, stop_reason):
    message = ai_message("A complete reply.")
    message.response_metadata = {} if stop_reason is None else {"stop_reason": stop_reason}
    fake_chain.result = message

    assert draft_reply(make_state([ARTICLE_A]))["draft_truncated"] is False


def test_a_message_with_no_metadata_at_all_is_not_truncated(fake_chain):
    message = ai_message("A complete reply.")
    message.response_metadata = {}
    message.usage_metadata = None
    fake_chain.result = message

    result = draft_reply(make_state([ARTICLE_A]))

    assert result == {"draft_reply": "A complete reply.", "draft_truncated": False}


def test_a_cut_off_draft_is_logged_as_a_warning(fake_chain, caplog):
    fake_chain.result = ai_message("Cut off mid", "max_tokens", output_tokens=700)

    with caplog.at_level("INFO", logger="app.graph.reply_draft"):
        draft_reply(make_state([ARTICLE_A]))

    warnings = [r for r in caplog.records if r.levelname == "WARNING"]
    assert len(warnings) == 1
    assert "cut off at the token limit" in warnings[0].getMessage()
    assert "output_tokens=700" in warnings[0].getMessage()


def test_a_finished_draft_logs_only_info_with_the_token_count(fake_chain, caplog):
    fake_chain.result = ai_message("Done.", "end_turn", output_tokens=120)

    with caplog.at_level("INFO", logger="app.graph.reply_draft"):
        draft_reply(make_state([ARTICLE_A]))

    assert [r.levelname for r in caplog.records] == ["INFO"]
    assert "output_tokens=120" in caplog.records[0].getMessage()


def test_the_prompt_inputs_are_unchanged_by_the_cut_off_check(fake_chain):
    draft_reply(make_state([ARTICLE_A]))

    sent = fake_chain.calls[0]
    assert set(sent) == {"subject", "body", "kb_context"}

def prompt_messages():
    return reply_draft._prompt.invoke(
        {"subject": "S", "body": "B", "kb_context": NO_KB_TEXT}
    ).to_messages()


def test_the_existing_system_instructions_are_still_there():
    system = prompt_messages()[0].content

    assert system.startswith(
        "You are a support agent drafting a reply to a customer ticket. "
        "Use the provided knowledge base context to ground your answer in "
        "facts — do not invent policies or details that aren't in the "
        "context. If the context doesn't cover the issue, write a reply "
        "that acknowledges the issue and says a specialist will follow up, "
        "rather than guessing. Keep the tone professional and concise."
    )


def test_the_three_grounding_rules_are_in_their_own_paragraph_word_for_word():
    system = prompt_messages()[0].content

    assert system.endswith(
        "\n\nRules for every reply:\n"
        "1. Use only facts stated in the knowledge base articles provided. Do not add tips, "
        "troubleshooting steps, procedures, timeframes or policies from general knowledge, "
        "even if they seem helpful. If the customer asks about something the articles do not "
        "cover, say that a member of the team will follow up on that part, and do not guess.\n"
        "2. You cannot see or change the customer's account. Never claim to have checked, "
        "seen, confirmed, processed or changed anything on their account, and never state the "
        "account's current status as fact. You may refer to what the customer told you, as "
        "their statement, for example \"You mentioned that...\".\n"
        "3. Never include placeholders, bracketed text, template markers or notes to staff. "
        "Every sentence must be ready to send to the customer as written. If a detail is "
        "missing from the articles, leave it out rather than marking where it would go."
    )


def test_the_human_message_is_unchanged():
    human = prompt_messages()[1].content

    assert human == (
        "Ticket subject: S\nTicket body: B\n\n"
        f"Knowledge base context:\n{NO_KB_TEXT}\n\n"
        "Draft a reply to the customer."
    )
