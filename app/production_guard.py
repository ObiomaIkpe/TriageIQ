"""Refuse to start in production (APP_ENV=production) with a setting that is only fit for development.

Called first thing at startup (app/main.py). Every message names the SETTING and the rule, never a value, so a
secret can never reach a log. The gateway has the same guard for its own settings (gateway/src/config/production-guard.ts).
"""
import re
from urllib.parse import urlsplit

from app.config import Settings

# A value copied from an .example file and never replaced ("replace-with-...", "REPLACE_ME...").
_PLACEHOLDER = re.compile(r"replace[-_ ]?(me|with)", re.IGNORECASE)
# The development database logins that must never be used in production (superuser / the dev password).
_DEV_DB_USERS = {"postgres", "triageiq"}
_DEV_DB_PASSWORDS = {"triageiq", "postgres", "password"}


class ProductionConfigError(RuntimeError):
    """The configuration is unfit for production. The message lists every problem, without values."""

    def __init__(self, problems: list[str]):
        self.problems = problems
        super().__init__("Refusing to start in production: " + "; ".join(problems) + ".")


def is_placeholder(value: str) -> bool:
    return bool(_PLACEHOLDER.search(value))


def production_problems(settings: Settings) -> list[str]:
    """The problems that make this configuration unfit for production. Empty outside production."""
    if settings.app_env.strip().lower() != "production":
        return []
    problems: list[str] = []

    for name, value in (
        ("ANTHROPIC_API_KEY", settings.anthropic_api_key),
        ("VOYAGE_API_KEY", settings.voyage_api_key),
        ("REVIEW_API_KEY", settings.review_api_key),
    ):
        if not value.strip():
            problems.append(f"{name} is not set")
        elif is_placeholder(value):
            problems.append(f"{name} still has its .example placeholder value")

    try:
        parts = urlsplit(settings.database_url)
        user, password = parts.username or "", parts.password or ""
    except ValueError:
        user = password = ""
        problems.append("DATABASE_URL is not a valid URL")
    if is_placeholder(settings.database_url):
        problems.append("DATABASE_URL still has its .example placeholder value")
    if user in _DEV_DB_USERS:
        problems.append("DATABASE_URL uses a database superuser or development login; use the least-privilege triageiq_app role")
    if password in _DEV_DB_PASSWORDS:
        problems.append("DATABASE_URL uses a development database password")

    if settings.langsmith_tracing and not settings.langsmith_api_key.strip():
        problems.append("LANGSMITH_TRACING is true but LANGSMITH_API_KEY is not set")
    return problems


def check_production(settings: Settings) -> None:
    problems = production_problems(settings)
    if problems:
        raise ProductionConfigError(problems)
