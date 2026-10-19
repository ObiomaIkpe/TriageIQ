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

# --- LangSmith tracing settings ---------------------------------------------

def test_the_tracing_settings_use_the_current_langsmith_names():
    fields = set(Settings.model_fields)

    assert {"langsmith_tracing", "langsmith_api_key", "langsmith_project"} <= fields
    assert not {f for f in fields if f.startswith("langchain_")}


def test_tracing_is_off_by_default():
    assert Settings.model_fields["langsmith_tracing"].default is False


def test_tracing_can_be_switched_on_from_the_environment(monkeypatch):
    monkeypatch.setenv("LANGSMITH_TRACING", "true")

    assert Settings(_env_file=None).langsmith_tracing is True


def test_the_legacy_names_in_an_old_env_file_do_not_break_startup(monkeypatch):
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "true")
    monkeypatch.setenv("LANGCHAIN_API_KEY", "k")

    settings_without_error = Settings(_env_file=None)

    assert settings_without_error.langsmith_tracing is False  # ignored, not an error


def test_the_env_example_lists_only_names_the_app_knows():
    from pathlib import Path

    text = (Path(__file__).resolve().parents[1] / ".env.example").read_text()
    names = {line.split("=")[0].strip().lower() for line in text.splitlines() if "=" in line}

    assert not {n for n in names if n.startswith("langchain_")}
    assert names <= set(Settings.model_fields), names - set(Settings.model_fields)
