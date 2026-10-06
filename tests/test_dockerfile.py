from pathlib import Path

DOCKERFILE = (Path(__file__).resolve().parents[1] / "Dockerfile").read_text()


def _copy_lines():
    return [
        line.split() for line in DOCKERFILE.splitlines() if line.startswith("COPY ")
    ]


def test_the_image_contains_the_alembic_config_and_migrations():
    # The app runs the migrations at startup, so the container needs both.
    sources = [parts[1] for parts in _copy_lines()]

    assert "alembic.ini" in sources
    assert "alembic/" in sources


def test_the_alembic_files_land_where_the_app_looks_for_them():
    # app/migrations.py resolves them next to the app/ directory, i.e. /app.
    destinations = {parts[1]: parts[2] for parts in _copy_lines()}

    assert destinations["app/"] == "./app/"
    assert destinations["alembic.ini"] == "."
    assert destinations["alembic/"] == "./alembic/"


def test_the_dependencies_include_the_migration_tooling():
    requirements = (Path(__file__).resolve().parents[1] / "requirements.txt").read_text()

    assert "alembic==" in requirements
    assert "SQLAlchemy==" in requirements
