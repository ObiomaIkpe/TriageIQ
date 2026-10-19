import pytest
from pydantic import ValidationError

from app.config import Settings, settings
from app.graph import classifier, critic, reply_draft

NODES = [classifier, reply_draft, critic]


def _timeout(llm):
    # The attribute name has varied across langchain-anthropic versions.
    for name in ("default_request_timeout", "request_timeout", "timeout"):
        value = getattr(llm, name, None)
        if value is not None:
            return value
    raise AssertionError("no timeout attribute found on ChatAnthropic")


@pytest.mark.parametrize("node", NODES, ids=lambda m: m.__name__)
def test_llm_uses_configured_retries(node):
    assert node._llm.max_retries == settings.llm_max_retries


@pytest.mark.parametrize("node", NODES, ids=lambda m: m.__name__)
def test_llm_uses_configured_timeout(node):
    assert _timeout(node._llm) == settings.llm_timeout_seconds


@pytest.mark.parametrize("node", NODES, ids=lambda m: m.__name__)
def test_llm_uses_configured_max_tokens(node):
    assert node._llm.max_tokens == settings.llm_max_tokens


@pytest.mark.parametrize("node", NODES, ids=lambda m: m.__name__)
def test_the_request_sent_to_claude_carries_the_configured_max_tokens(node):
    # Built offline: this is the payload the node would send, with no network call.
    payload = node._llm._get_request_payload([("human", "hi")])

    assert payload["max_tokens"] == settings.llm_max_tokens


def test_defaults_are_bounded():
    assert settings.llm_timeout_seconds == 30.0
    assert settings.llm_max_retries == 2


def test_the_max_tokens_default_is_700():
    # The field's default, not the live value, so a local .env cannot change it.
    assert Settings.model_fields["llm_max_tokens"].default == 700


def test_max_tokens_can_be_set_from_the_environment(monkeypatch):
    monkeypatch.setenv("LLM_MAX_TOKENS", "1200")

    assert Settings(_env_file=None).llm_max_tokens == 1200


@pytest.mark.parametrize("bad", ["0", "-5", "abc"])
def test_a_bad_max_tokens_fails_at_startup_not_at_the_first_request(monkeypatch, bad):
    monkeypatch.setenv("LLM_MAX_TOKENS", bad)

    with pytest.raises(ValidationError):
        Settings(_env_file=None)