"""APP_ENV=production refuses development-only settings, names them, and never prints a value."""
import re
from pathlib import Path

import pytest

from app.config import Settings
from app.production_guard import ProductionConfigError, check_production, is_placeholder, production_problems

GOOD = dict(
    app_env="production",
    anthropic_api_key="sk-ant-real-0123456789",
    voyage_api_key="pa-real-0123456789",
    review_api_key="f3a9c1d2e4b5",
    database_url="postgresql://triageiq_app:Zk3pQ9x2@db:5432/triageiq",
)


def settings_with(**change):
    return Settings(_env_file=None, **{**GOOD, **change})


def test_a_good_production_configuration_passes():
    check_production(settings_with())


@pytest.mark.parametrize("change,fragment", [
    ({"anthropic_api_key": ""}, "ANTHROPIC_API_KEY is not set"),
    ({"voyage_api_key": ""}, "VOYAGE_API_KEY is not set"),
    ({"review_api_key": ""}, "REVIEW_API_KEY is not set"),
    ({"review_api_key": "replace-with-the-value-of-REVIEW_API_KEY"}, "REVIEW_API_KEY still has its .example placeholder"),
    ({"anthropic_api_key": "REPLACE_ME_ANTHROPIC_API_KEY"}, "ANTHROPIC_API_KEY still has its .example placeholder"),
    ({"database_url": "postgresql://triageiq:triageiq@db:5432/triageiq"}, "superuser or development login"),
    ({"database_url": "postgresql://postgres:Zk3pQ9@db:5432/triageiq"}, "superuser or development login"),
    ({"database_url": "postgresql://triageiq_app:triageiq@db:5432/triageiq"}, "development database password"),
    ({"database_url": "postgresql://triageiq_app:REPLACE_ME_APP_DB_PASSWORD@db:5432/triageiq"}, "DATABASE_URL still has its .example placeholder"),
    ({"langsmith_tracing": True, "langsmith_api_key": ""}, "LANGSMITH_TRACING is true but LANGSMITH_API_KEY is not set"),
])
def test_each_bad_setting_is_refused_with_its_name(change, fragment):
    with pytest.raises(ProductionConfigError) as caught:
        check_production(settings_with(**change))
    assert fragment in str(caught.value)


def test_every_problem_is_listed_at_once():
    with pytest.raises(ProductionConfigError) as caught:
        check_production(settings_with(review_api_key="", voyage_api_key=""))
    assert len(caught.value.problems) == 2


def test_no_secret_value_ever_appears_in_the_message():
    secret = "SUPERSECRETVALUE9"
    bad = settings_with(review_api_key=f"replace-with-{secret}", database_url=f"postgresql://triageiq:{secret}@db/x")
    with pytest.raises(ProductionConfigError) as caught:
        check_production(bad)
    assert secret not in str(caught.value) and secret not in repr(caught.value.problems)


@pytest.mark.parametrize("env", ["development", "", "test", "staging"])
def test_nothing_is_checked_outside_production(env):
    assert production_problems(Settings(_env_file=None, app_env=env)) == []


def test_production_is_matched_ignoring_case_and_spaces():
    assert production_problems(Settings(_env_file=None, app_env=" Production ")) != []


def test_a_real_key_containing_the_word_replace_is_not_a_placeholder():
    assert not is_placeholder("my-key-to-replace-later")
    assert is_placeholder("replace-with-something") and is_placeholder("REPLACE_ME_X")


def test_the_app_refuses_to_start_when_production_is_misconfigured(monkeypatch):
    import app.main as main

    monkeypatch.setattr(main, "settings", settings_with(review_api_key=""))
    from fastapi.testclient import TestClient

    with pytest.raises(ProductionConfigError):
        with TestClient(main.app):
            pass


def test_the_example_files_placeholders_are_all_caught():
    root = Path(__file__).resolve().parents[1]
    example = root / "deploy" / "env" / "app.env.example"
    if not example.exists():
        pytest.skip("deploy/env/app.env.example is not in this checkout")
    for line in example.read_text().splitlines():
        match = re.match(r"^(ANTHROPIC_API_KEY|VOYAGE_API_KEY|REVIEW_API_KEY|DATABASE_URL)=(.*)$", line)
        if match:
            assert is_placeholder(match.group(2)), f"{match.group(1)} in app.env.example is not recognised as a placeholder"
