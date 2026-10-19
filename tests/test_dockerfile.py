import fnmatch
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


# --- .dockerignore ------------------------------------------------------------

ROOT = Path(__file__).resolve().parents[1]


def _ignore_patterns():
    lines = (ROOT / ".dockerignore").read_text().splitlines()
    return [line.strip() for line in lines if line.strip() and not line.startswith("#")]


def _is_hidden(path, patterns):
    """Roughly how Docker applies .dockerignore: the path, or a folder above it, matches."""
    parts = path.rstrip("/").split("/")
    candidates = ["/".join(parts[: i + 1]) for i in range(len(parts))]
    for pattern in patterns:
        pattern = pattern.rstrip("/")
        if pattern.startswith("!"):
            continue
        if any(fnmatch.fnmatch(candidate, pattern) for candidate in candidates):
            return True
    return False


def test_the_dockerignore_exists():
    assert (ROOT / ".dockerignore").is_file()


def test_the_dockerignore_keeps_secrets_and_clutter_out_of_the_build():
    patterns = _ignore_patterns()

    for expected in (".env", ".git", "venv", "**/__pycache__", "**/*.pyc", "*.sql"):
        assert expected in [p.rstrip("/") for p in patterns], expected


def _files_the_image_needs():
    """Every real file under the paths the Dockerfile copies (caches excluded)."""
    files = []
    for parts in _copy_lines():
        source = parts[1].rstrip("/")
        path = ROOT / source
        found = [path] if path.is_file() else [f for f in path.rglob("*") if f.is_file()]
        for f in found:
            relative = f.relative_to(ROOT).as_posix()
            if "__pycache__" not in relative and not relative.endswith(".pyc"):
                files.append(relative)
    return files


def test_the_dockerignore_does_not_hide_anything_the_dockerfile_copies():
    sources = [parts[1] for parts in _copy_lines()]
    patterns = _ignore_patterns()

    hidden = [source for source in sources if _is_hidden(source, patterns)]
    assert not hidden, f"the Dockerfile copies these, but .dockerignore hides them: {hidden}"


def test_the_dockerignore_does_not_hide_a_single_source_file_the_image_needs():
    # Catches patterns like **/*.py that match files but not the folder names above.
    files = _files_the_image_needs()
    assert "app/main.py" in files and "alembic/versions/0001_initial_schema.py" in files

    hidden = [f for f in files if _is_hidden(f, _ignore_patterns())]
    assert not hidden, f".dockerignore would strip these from the image: {hidden}"


def test_the_pycache_folders_inside_the_copied_directories_are_ignored():
    patterns = _ignore_patterns()

    assert _is_hidden("app/__pycache__", patterns)
    assert _is_hidden("alembic/versions/__pycache__/x.cpython-312.pyc", patterns)
    assert not _is_hidden("app/main.py", patterns)
    assert not _is_hidden("alembic/versions/0001_initial_schema.py", patterns)
