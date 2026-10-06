from pathlib import Path
from typing import Optional

from alembic import command
from alembic.config import Config

# The repository root (or /app in the container), where alembic.ini and the
# alembic/ directory live.
ROOT = Path(__file__).resolve().parents[1]


def alembic_config(url: Optional[str] = None) -> Config:
    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("script_location", str(ROOT / "alembic"))
    if url:
        cfg.set_main_option("sqlalchemy.url", url.replace("%", "%%"))
    # The app configures its own logging; env.py must not replace it.
    cfg.attributes["configure_logger"] = False
    return cfg


def run_migrations(url: Optional[str] = None) -> None:
    """Bring the database up to the latest schema.

    Safe to run on every startup: when nothing is pending it does nothing. With
    no url it uses DATABASE_URL from the app settings (see alembic/env.py).
    """
    command.upgrade(alembic_config(url), "head")
