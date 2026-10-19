import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient

from app.api.auth import require_review_key
from app.config import settings

KEY = "dummy-review-key"

app = FastAPI()


@app.get("/guarded", dependencies=[Depends(require_review_key)])
def guarded():
    return {"ok": True}


client = TestClient(app)


@pytest.fixture
def key_set(monkeypatch):
    monkeypatch.setattr(settings, "review_api_key", KEY)


def test_a_missing_header_is_401(key_set):
    response = client.get("/guarded")

    assert response.status_code == 401


def test_a_wrong_key_is_401(key_set):
    assert client.get("/guarded", headers={"X-API-Key": "nope"}).status_code == 401


def test_a_key_that_is_only_a_prefix_or_extension_is_401(key_set):
    for wrong in (KEY[:-1], KEY + "x", KEY.upper(), ""):
        assert client.get("/guarded", headers={"X-API-Key": wrong}).status_code == 401, wrong


def test_the_correct_key_passes(key_set):
    response = client.get("/guarded", headers={"X-API-Key": KEY})

    assert response.status_code == 200
    assert response.json() == {"ok": True}


def test_the_header_name_is_case_insensitive(key_set):
    assert client.get("/guarded", headers={"x-api-key": KEY}).status_code == 200


def test_a_non_ascii_key_is_401_not_a_crash(key_set):
    # httpx refuses a non-ASCII str header, so send the raw bytes a real client could.
    response = client.get("/guarded", headers={"X-API-Key": "cl\xe9".encode("latin-1")})

    assert response.status_code == 401


def test_an_empty_setting_disables_the_endpoint_whatever_the_header(monkeypatch):
    monkeypatch.setattr(settings, "review_api_key", "")

    for headers in ({}, {"X-API-Key": ""}, {"X-API-Key": "anything"}):
        response = client.get("/guarded", headers=headers)
        assert response.status_code == 503, headers
        assert response.json()["detail"] == "Review is disabled: REVIEW_API_KEY is not set"


def test_the_setting_is_read_on_every_request(monkeypatch):
    monkeypatch.setattr(settings, "review_api_key", "first")
    assert client.get("/guarded", headers={"X-API-Key": "first"}).status_code == 200

    monkeypatch.setattr(settings, "review_api_key", "second")
    assert client.get("/guarded", headers={"X-API-Key": "first"}).status_code == 401
    assert client.get("/guarded", headers={"X-API-Key": "second"}).status_code == 200


def test_the_default_setting_is_empty_so_the_endpoint_starts_disabled():
    from app.config import Settings

    assert Settings.model_fields["review_api_key"].default == ""


def test_the_comparison_is_constant_time():
    import inspect

    assert "compare_digest" in inspect.getsource(require_review_key)


def _repo_file(name):
    from pathlib import Path

    return (Path(__file__).resolve().parents[1] / name).read_text()


def test_the_env_example_lists_the_review_key_as_a_commented_optional_setting():
    lines = [l.strip() for l in _repo_file(".env.example").splitlines()]

    assert "# REVIEW_API_KEY=" in lines  # commented out, showing the real (empty) default
    assert "REVIEW_API_KEY=" not in lines  # never active in a copy of the example


def test_the_readme_documents_the_review_key_and_the_endpoint():
    readme = _repo_file("README.md")

    assert "REVIEW_API_KEY" in readme
    assert "X-API-Key" in readme
    assert "/tickets/{ticket_id}/review" in readme
