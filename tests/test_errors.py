import anthropic
import httpx
import pytest
from fastapi.testclient import TestClient

from app.errors import RETRY_AFTER_SECONDS, TRANSIENT_LLM_ERRORS
from app.graph import classifier
from app.main import app

# raise_server_exceptions=False so unhandled errors come back as a real 500
# response, the way a client would see them.
client = TestClient(app, raise_server_exceptions=False)

REQUEST = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
TICKET = {"subject": "Cannot log in", "body": "Account locked."}


def status_error(cls, status):
    return cls("error", response=httpx.Response(status, request=REQUEST), body=None)


class RaisingChain:
    def __init__(self, error):
        self.error = error

    def invoke(self, inputs):
        raise self.error


def fail_classifier_with(monkeypatch, error):
    monkeypatch.setattr(classifier, "_chain", RaisingChain(error))


TRANSIENT_CASES = [
    pytest.param(lambda: anthropic.APIConnectionError(request=REQUEST), id="connection"),
    pytest.param(lambda: anthropic.APITimeoutError(request=REQUEST), id="timeout"),
    pytest.param(lambda: status_error(anthropic.RateLimitError, 429), id="rate-limit"),
    pytest.param(lambda: status_error(anthropic.InternalServerError, 500), id="server-error"),
]


@pytest.mark.parametrize("make_error", TRANSIENT_CASES)
def test_transient_llm_failure_returns_503_with_retry_after(monkeypatch, make_error):
    fail_classifier_with(monkeypatch, make_error())

    response = client.post("/triage", json=TICKET)

    assert response.status_code == 503
    assert response.headers["Retry-After"] == str(RETRY_AFTER_SECONDS)
    assert response.json() == {
        "detail": "Triage is temporarily unavailable. Please retry."
    }


def test_auth_error_is_not_reported_as_an_outage(monkeypatch):
    fail_classifier_with(monkeypatch, status_error(anthropic.AuthenticationError, 401))

    response = client.post("/triage", json=TICKET)

    assert response.status_code == 500


def test_unexpected_error_is_still_a_500(monkeypatch):
    fail_classifier_with(monkeypatch, ValueError("a real bug"))

    response = client.post("/triage", json=TICKET)

    assert response.status_code == 500


def test_the_main_transient_errors_are_registered():
    # Guards the defensive name lookup in app/errors.py from silently
    # dropping a class if the SDK renames it.
    assert anthropic.APIConnectionError in TRANSIENT_LLM_ERRORS
    assert anthropic.RateLimitError in TRANSIENT_LLM_ERRORS
    assert anthropic.InternalServerError in TRANSIENT_LLM_ERRORS