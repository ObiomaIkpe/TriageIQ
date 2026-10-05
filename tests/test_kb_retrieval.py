import pytest

from app.graph import kb_retrieval
from app.graph.kb_retrieval import retrieve_kb_context
from app.models import TicketIn


@pytest.fixture
def fake_search(monkeypatch):
    """Replace search_similar so no Voyage or Postgres call is made."""
    calls = []

    def _fake(query_text, top_k):
        calls.append({"query_text": query_text, "top_k": top_k})
        return _fake.results

    _fake.results = []
    _fake.calls = calls
    monkeypatch.setattr(kb_retrieval, "search_similar", _fake)
    return _fake


def make_state() -> dict:
    return {"ticket": TicketIn(subject="Cannot log in", body="Account locked.")}


def test_matches_are_stored_in_kb_context(fake_search):
    fake_search.results = ["Article A", "Article B"]

    result = retrieve_kb_context(make_state())

    assert result["kb_context"] == ["Article A", "Article B"]


def test_no_matches_gives_empty_list(fake_search):
    fake_search.results = []

    result = retrieve_kb_context(make_state())

    assert result["kb_context"] == []


def test_query_is_subject_plus_body_and_top_k_is_3(fake_search):
    retrieve_kb_context(make_state())

    assert fake_search.calls == [
        {"query_text": "Cannot log in Account locked.", "top_k": 3}
    ]


def test_retrieval_returns_only_its_own_keys(fake_search):
    result = retrieve_kb_context(make_state())

    assert set(result) == {"kb_context", "kb_failed"}


def test_retrieval_failure_path_returns_only_its_own_keys(monkeypatch):
    def boom(query_text, top_k):
        raise RuntimeError("voyage or postgres is down")

    monkeypatch.setattr(kb_retrieval, "search_similar", boom)

    result = retrieve_kb_context(make_state())

    assert set(result) == {"kb_context", "kb_failed"}


def test_search_failure_degrades_to_empty_context_and_sets_flag(monkeypatch):
    def boom(query_text, top_k):
        raise RuntimeError("voyage or postgres is down")

    monkeypatch.setattr(kb_retrieval, "search_similar", boom)

    result = retrieve_kb_context(make_state())

    assert result["kb_context"] == []
    assert result["kb_failed"] is True


def test_successful_search_clears_the_failure_flag(fake_search):
    fake_search.results = ["Article A"]

    result = retrieve_kb_context(make_state())

    assert result["kb_failed"] is False