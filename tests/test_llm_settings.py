import re
from pathlib import Path

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


_ENV_LINE = re.compile(r"^\s*#?\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$")


def _env_example_entries():
    """(name, value, commented_out) for every NAME=value line, commented or not."""
    text = (Path(__file__).resolve().parents[1] / ".env.example").read_text()
    entries = []
    for line in text.splitlines():
        match = _ENV_LINE.match(line)
        if match:
            entries.append((match.group(1), match.group(2).strip(), line.lstrip().startswith("#")))
    return entries


def test_the_env_example_lists_only_names_the_app_knows():
    names = {name.lower() for name, _, _ in _env_example_entries()}

    assert not {n for n in names if n.startswith("langchain_")}
    assert names <= set(Settings.model_fields), names - set(Settings.model_fields)


def test_the_env_example_has_no_two_names_that_differ_only_by_case():
    # Settings match names case-insensitively, so anthropic_api_key and
    # ANTHROPIC_API_KEY would be the same setting written twice.
    lowered = [name.lower() for name, _, _ in _env_example_entries()]
    duplicates = sorted({n for n in lowered if lowered.count(n) > 1})

    assert not duplicates, f"names listed twice: {duplicates}"


def test_the_env_example_mentions_every_setting():
    listed = {name.lower() for name, _, _ in _env_example_entries()}

    missing = set(Settings.model_fields) - listed
    assert not missing, f"add these to .env.example (commented out is fine): {sorted(missing)}"


def test_the_commented_out_examples_show_the_real_defaults():
    # So the example file cannot quietly drift away from app/config.py.
    commented = [(n, v) for n, v, is_commented in _env_example_entries() if is_commented]

    assert commented, "expected the optional settings to be listed as comments"
    for name, value in commented:
        assert str(Settings.model_fields[name.lower()].default) == value, name


def test_the_optional_settings_are_commented_out_so_a_copy_of_the_file_uses_the_defaults():
    uncommented = {n.lower() for n, _, is_commented in _env_example_entries() if not is_commented}

    assert not {"model_id", "llm_timeout_seconds", "llm_max_retries", "llm_max_tokens",
                "low_confidence_threshold", "voyage_rpm"} & uncommented
