from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.api.deps import get_graph
from app.errors import RETRY_AFTER_SECONDS


def request_with(**state):
    return SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(**state)))


def test_it_returns_the_graph_stored_on_app_state():
    graph = object()

    assert get_graph(request_with(triage_graph=graph)) is graph


@pytest.mark.parametrize("state", [{"triage_graph": None}, {}])
def test_a_missing_graph_is_a_retryable_503(state):
    with pytest.raises(HTTPException) as caught:
        get_graph(request_with(**state))

    assert caught.value.status_code == 503
    assert caught.value.detail == (
        "Triage is starting up or the database is unavailable. Please retry."
    )
    assert caught.value.headers == {"Retry-After": str(RETRY_AFTER_SECONDS)}
