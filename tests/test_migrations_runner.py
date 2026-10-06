from pathlib import Path

from app import migrations


def test_the_config_points_at_the_repositorys_alembic_directory():
    cfg = migrations.alembic_config()

    script_location = Path(cfg.get_main_option("script_location"))
    assert script_location == migrations.ROOT / "alembic"
    assert (script_location / "env.py").is_file()
    assert any((script_location / "versions").glob("0001_*.py"))
    assert (migrations.ROOT / "alembic.ini").is_file()


def test_no_url_is_set_so_env_py_falls_back_to_the_app_settings():
    assert not migrations.alembic_config().get_main_option("sqlalchemy.url")


def test_a_given_url_is_set_on_the_config():
    cfg = migrations.alembic_config("postgresql+psycopg://u:p@localhost:5433/x_test")

    assert cfg.get_main_option("sqlalchemy.url") == (
        "postgresql+psycopg://u:p@localhost:5433/x_test"
    )


def test_a_percent_in_the_url_survives_the_config_parser():
    cfg = migrations.alembic_config("postgresql+psycopg://u:p%40ss@localhost/x_test")

    assert cfg.get_main_option("sqlalchemy.url") == (
        "postgresql+psycopg://u:p%40ss@localhost/x_test"
    )


def test_the_config_stops_env_py_from_replacing_the_apps_logging():
    assert migrations.alembic_config().attributes["configure_logger"] is False


def test_run_migrations_upgrades_to_head(monkeypatch):
    calls = []
    monkeypatch.setattr(
        migrations.command, "upgrade", lambda cfg, revision: calls.append((cfg, revision))
    )

    migrations.run_migrations()

    assert len(calls) == 1
    cfg, revision = calls[0]
    assert revision == "head"
    assert cfg.attributes["configure_logger"] is False


def test_run_migrations_passes_a_url_through(monkeypatch):
    calls = []
    monkeypatch.setattr(
        migrations.command, "upgrade", lambda cfg, revision: calls.append(cfg)
    )

    migrations.run_migrations("postgresql+psycopg://u:p@localhost/x_test")

    assert calls[0].get_main_option("sqlalchemy.url") == (
        "postgresql+psycopg://u:p@localhost/x_test"
    )
