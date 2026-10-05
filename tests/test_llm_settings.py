import pytest

from app.config import settings
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


def test_defaults_are_bounded():
    assert settings.llm_timeout_seconds == 30.0
    assert settings.llm_max_retries == 2