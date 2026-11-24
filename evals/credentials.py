"""Credentials for the evals: taken from app/config.py settings (which read .env), exactly like the app.

The graph nodes build their Claude clients without an api_key, so the client library looks in
os.environ. Settings read .env but never export it, so a key that is only in .env was invisible to them.
`export_credentials` copies it into the process environment (never overwriting a value the shell
already set). Call it BEFORE importing app.graph.*. Nothing here prints or logs a key.
"""
import os


def missing_keys(settings) -> list:
    """Names (never values) of the required keys that are empty."""
    required = {"ANTHROPIC_API_KEY": settings.anthropic_api_key, "VOYAGE_API_KEY": settings.voyage_api_key}
    return [name for name, value in required.items() if not (value or "").strip()]


def export_credentials(settings) -> None:
    for name, value in (("ANTHROPIC_API_KEY", settings.anthropic_api_key),
                        ("VOYAGE_API_KEY", settings.voyage_api_key)):
        if (value or "").strip() and not (os.environ.get(name) or "").strip():
            os.environ[name] = value.strip()
