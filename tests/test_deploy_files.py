"""Guards on the deployment files that are easy to weaken by accident: the CI publish job's permissions, pinned actions,
the web image's headers, and what the Docker build contexts exclude."""
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
CI = yaml.safe_load((ROOT / ".github/workflows/ci.yml").read_text())
CI_TEXT = (ROOT / ".github/workflows/ci.yml").read_text()


def test_only_the_publish_job_can_write_packages():
    assert CI["permissions"] == {"contents": "read"}
    writers = [name for name, job in CI["jobs"].items() if "packages" in job.get("permissions", {})]
    assert writers == ["publish-images"]
    assert CI["jobs"]["publish-images"]["permissions"] == {"contents": "read", "packages": "write"}


def test_publishing_happens_only_on_main_after_all_four_checks():
    job = CI["jobs"]["publish-images"]
    assert job["needs"] == ["python", "gateway", "web", "docker-build"]
    assert job["if"] == "github.event_name == 'push' && github.ref == 'refs/heads/main'"
    triggers = CI.get("on", CI.get(True))  # YAML 1.1 reads the key `on` as the boolean True
    assert triggers["push"]["branches"] == ["main"]


def test_every_pushed_image_gets_a_sha_tag_and_main():
    steps = [s for s in CI["jobs"]["publish-images"]["steps"] if str(s.get("name", "")).startswith("Push the")]
    assert len(steps) == 3
    for step in steps:
        tags = step["with"]["tags"]
        assert "short }}" in tags and ":main" in tags and step["with"]["push"] is True


def test_the_site_key_is_a_variable_not_a_secret():
    assert "vars.VITE_TURNSTILE_SITE_KEY" in CI_TEXT
    assert not re.search(r"\$\{\{\s*secrets\.(?!GITHUB_TOKEN)", CI_TEXT), "the workflow must use no secret except the automatic GITHUB_TOKEN"


def test_every_action_is_pinned_to_a_full_commit_sha():
    uses = re.findall(r"uses:\s*(\S+)", CI_TEXT)
    assert uses and all(re.fullmatch(r"[\w./-]+@[0-9a-f]{40}", u) for u in uses), uses


def test_main_runs_are_never_cancelled_mid_publish():
    assert "cancel-in-progress: ${{ github.event_name == 'pull_request' }}" in CI_TEXT


def test_the_web_image_sends_the_security_headers_in_every_location():
    conf = (ROOT / "web/nginx/default.conf").read_text()
    locations = re.findall(r"location [^{]+\{(.*?)\n  \}", conf, re.S)
    assert len(locations) == 4
    assert all("include /etc/nginx/security-headers.conf;" in body for body in locations)
    headers = (ROOT / "web/nginx/security-headers.conf").read_text()
    assert "script-src 'self' https://challenges.cloudflare.com;" in headers
    assert "frame-src https://challenges.cloudflare.com;" in headers
    assert "frame-ancestors 'none'" in headers
    assert "unsafe-inline" not in headers and "unsafe-eval" not in headers
    assert headers.count("always;") == 5


def test_the_web_dockerfile_runs_unprivileged_and_takes_the_site_key_as_a_build_arg():
    text = (ROOT / "web/Dockerfile").read_text()
    assert "nginx-unprivileged" in text and "ARG VITE_TURNSTILE_SITE_KEY" in text
    assert not re.search(r"^USER\s+root", text, re.M)


def test_env_files_stay_out_of_every_build_context():
    for context in ("", "gateway/", "web/"):
        text = (ROOT / context / ".dockerignore").read_text()
        assert re.search(r"^(\*\*/)?\.env$", text, re.M), context
    root = (ROOT / ".dockerignore").read_text()
    assert "**/*.env" in root and "deploy/" in root


def test_deploy_secrets_are_git_ignored_and_examples_are_not():
    ignore = (ROOT / "deploy/.gitignore").read_text()
    assert "env/*.env" in ignore and ".env" in ignore and "env.local-test/" in ignore
    for name in ("db", "app", "gateway"):
        assert (ROOT / f"deploy/env/{name}.env.example").exists()


def test_deploy_db_scripts_are_exact_copies_of_db():
    for name in ("app-db.sql", "gateway-db.sql", "init/10-gateway-db.sh", "init/20-app-db.sh"):
        assert (ROOT / "db" / name).read_bytes() == (ROOT / "deploy/db" / name).read_bytes(), name
