"""The settings the tests run with come from the code defaults and the environment only: never from a local .env."""
from app.config import Settings, settings


def test_the_test_settings_are_the_code_defaults_not_a_developers_dotenv():
    # Settings(_env_file=None) reads no file. If the live `settings` had read a local .env, any value it changed would differ here.
    assert settings.model_dump() == Settings(_env_file=None).model_dump()


def test_the_provider_keys_are_fake_and_tracing_is_off():
    assert settings.anthropic_api_key == "test-key"
    assert settings.voyage_api_key == "test-key"
    assert settings.langsmith_api_key == ""
    assert settings.langsmith_tracing is False
