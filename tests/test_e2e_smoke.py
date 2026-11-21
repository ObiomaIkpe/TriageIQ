"""scripts/e2e_smoke.py against a FAKE gateway: no real stack, no keys, no cost.

The fake is a small http.server in this process. It mimics the gateway's contract (keys,
roles, job ownership, idempotency keys, reviewer routes). Its "faults" switch makes it break
one rule at a time, so the tests can check how the script reports a failure.
"""
import importlib.util
import json
import re
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "e2e_smoke.py"
spec = importlib.util.spec_from_file_location("e2e_smoke", SCRIPT)
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)

# Made-up keys. The tests check that none of them (or any part of them) is ever printed.
SUBMITTER_KEY = "tiq_test-Zq7vXk2mPw9sLd4tRn8cHb3yFg6jUe1a"
REVIEWER_KEY = "tiq_test-Mh5pTc8wQe2nVx6rKj9aDs4fLb7yGu3z"
OTHER_KEY = "tiq_test-Wy3gNf6kBa9xRq2eHt5mJc8vSd4pLz7u"
CLIENTS = {SUBMITTER_KEY: ("alice", "submitter"), REVIEWER_KEY: ("ops", "reviewer"), OTHER_KEY: ("bob", "submitter")}
ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
REVIEWER_EMAIL = "Ada.Reviewer@Example.com"
REVIEWER_PASSWORD = "typed-by-a-human-in-a-test-1"
ALLOWED_ORIGIN = "http://localhost:5173"


class FakeGateway:
    """State and rules of the fake. `faults` is a set of names, each breaking one behaviour."""

    def __init__(self):
        self.faults = set()
        self.jobs = {}  # id -> dict(client, subject, polls, ticket)
        self.idem = {}  # (client, key) -> job id
        self.tickets = {}  # ticket id -> record
        self.reviewed = set()
        self.polls_before_done = 2
        self.requests = []  # (method, path)
        self.sessions = {}  # session token -> email, for the cookie login
        self.allowed_origins = {ALLOWED_ORIGIN}
        self.last_token = None
        self.public_calls = []  # (headers, body) of every POST /public/tickets
        self.public_reads_before_found = 1  # the ticket is not there for the first read: the step must poll

    def new_ticket(self, subject):
        vague = "Help" in subject
        ticket_id = str(uuid.uuid4())
        reference = "TKT-" + "".join(ALPHABET[(i * 7 + len(self.tickets)) % len(ALPHABET)] for i in range(6))
        if "bad_reference" in self.faults:
            reference = "TKT-000000"
        record = {
            "ticket_id": ticket_id,
            "reference": reference,
            "status": "pending_review" if vague else "triaged",
            "needs_human_review": vague,
            "subject": subject,
        }
        self.tickets[ticket_id] = record
        return record


def make_handler(fake: FakeGateway):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):  # keep the test output quiet
            pass

        def send(self, status, body=None, headers=None):
            payload = json.dumps(body).encode() if body is not None else b""
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(payload)

        def client(self):
            header = self.headers.get("Authorization", "")
            if not header.startswith("Bearer "):
                return self.session_client()
            return CLIENTS.get(header[len("Bearer "):])

        def session_token(self):
            for part in (self.headers.get("Cookie") or "").split(";"):
                name, _, value = part.strip().partition("=")
                if name == "tiq_session":
                    return value
            return None

        def session_client(self):
            return ("ada", "reviewer") if self.session_token() in fake.sessions else None

        def handle_auth(self, method, path):
            origin_ok = self.headers.get("Origin") in fake.allowed_origins or "origin_ignored" in fake.faults
            if method == "POST" and path == "/auth/login":
                if not origin_ok:
                    return self.send(403, {"message": "Origin not allowed"})
                payload = self.body()
                if payload.get("email", "").lower() != REVIEWER_EMAIL.lower() or payload.get("password") != REVIEWER_PASSWORD:
                    return self.send(401, {"message": "Invalid email or password"})
                token = "".join(ALPHABET[(i * 5 + len(fake.sessions)) % len(ALPHABET)] for i in range(43))
                fake.sessions[token] = REVIEWER_EMAIL.lower()
                fake.last_token = token
                flags = "" if "cookie_no_httponly" in fake.faults else "; HttpOnly"
                same = "; SameSite=Lax" if "cookie_lax" in fake.faults else "; SameSite=Strict"
                cookie = f"tiq_session={token}; Max-Age=28800; Path=/{flags}; Secure{same}"
                return self.send(200, {"user": {"id": "u1", "email": REVIEWER_EMAIL.lower(), "role": "reviewer"}, "expires_at": "x"}, {"Set-Cookie": cookie})
            if method == "GET" and path == "/auth/me":
                email = fake.sessions.get(self.session_token())
                if email is None:
                    return self.send(401, {"message": "Not authenticated"})
                return self.send(200, {"user": {"id": "u1", "email": email, "role": "reviewer"}, "expires_at": "x"})
            if method == "POST" and path == "/auth/logout":
                if not origin_ok:
                    return self.send(403, {"message": "Origin not allowed"})
                if "logout_keeps_session" not in fake.faults:
                    fake.sessions.pop(self.session_token(), None)
                return self.send(204, None, {"Set-Cookie": "tiq_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict"})
            return self.send(404, {"detail": "no such route"})

        def body(self):
            length = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(length)) if length else {}

        def handle_any(self, method):
            path = self.path.split("?")[0]
            fake.requests.append((method, path))
            if path == "/health":
                return self.send(200, {"status": "ok"})
            if path == "/ready":
                triage = "down" if "triage_down" in fake.faults else "ok"
                return self.send(200, {"status": "ready", "checks": {"redis": "ok", "triage": triage}})
            if path.startswith("/auth/"):
                return self.handle_auth(method, path)
            if method == "POST" and path == "/public/tickets":
                return self.public_ticket()
            who = self.client()
            if who is None:
                return self.send(200 if "open_gateway" in fake.faults else 401, {"detail": "Missing or invalid API key"})
            name, role = who
            if method == "POST" and path == "/tickets":
                return self.create(name)
            if method == "GET" and path.startswith("/jobs/"):
                return self.job(path.rsplit("/", 1)[1], name, role)
            reviewer_only = path.startswith(("/tickets", "/dead-letters"))
            if reviewer_only and role != "reviewer":
                return self.send(200 if "submitter_allowed" in fake.faults else 403, {"detail": "Not allowed"})
            if method == "GET" and path == "/dead-letters":
                return self.send(200, {"items": [], "total": 0, "limit": 20, "offset": 0})
            if method == "GET" and path == "/tickets":
                return self.send(200, list(fake.tickets.values()))
            if method == "GET" and path.startswith("/tickets/reference/"):
                reference = path.rsplit("/", 1)[1]
                for record in fake.tickets.values():
                    if record["reference"] == reference:
                        if record.get("hidden_reads", 0) > 0:
                            record["hidden_reads"] -= 1
                            return self.send(404, {"detail": "Ticket not found"})
                        other = dict(record, subject="different") if "reads_differ" in fake.faults else record
                        return self.send(200, other)
                return self.send(404, {"detail": "Ticket not found"})
            if method == "GET" and path.startswith("/tickets/"):
                record = fake.tickets.get(path.rsplit("/", 1)[1])
                return self.send(200, record) if record else self.send(404, {"detail": "Ticket not found"})
            if method == "POST" and path.endswith("/review"):
                ticket_id = path.split("/")[2]
                if ticket_id not in fake.tickets:
                    return self.send(404, {"detail": "Ticket not found"})
                if ticket_id in fake.reviewed and "review_twice_ok" not in fake.faults:
                    return self.send(409, {"detail": "Ticket is not waiting for a review"})
                fake.reviewed.add(ticket_id)
                fake.tickets[ticket_id]["status"] = "edited"
                if "no_reviewed_by" not in fake.faults:
                    # who decided: the gateway records the authenticated principal; here, the API client's name
                    reviewer_name = "someone-else" if "wrong_reviewer" in fake.faults else name
                    fake.tickets[ticket_id]["reviewed_by"] = {"id": f"client:{reviewer_name}", "name": reviewer_name}
                return self.send(200, fake.tickets[ticket_id])
            return self.send(404, {"detail": "no such route"})

        def public_ticket(self):
            payload = self.body()
            fake.public_calls.append((dict(self.headers), payload))
            if "public_disabled" in fake.faults:
                return self.send(404, {"message": "Not Found"})
            if self.headers.get("Origin") not in fake.allowed_origins:
                return self.send(403, {"message": "Origin not allowed"})
            if not self.headers.get("Idempotency-Key"):
                return self.send(400, {"message": "Please check the form and try again."})
            if payload.get("turnstile_token") != "XXXX.DUMMY.TOKEN.XXXX":
                return self.send(403, {"message": "Verification failed, please try again."})
            record = fake.new_ticket(payload["subject"])
            record["customer_id"] = "public-form"
            record["customer_name"] = payload["name"]
            record["customer_email"] = payload["email"] if "email_not_lowercased" in fake.faults else payload["email"].strip().lower()
            record["hidden_reads"] = fake.public_reads_before_found
            body = {"reference": record["reference"], "message": "Thanks, we received your message."}
            if "public_leaks_job_id" in fake.faults:
                body["job_id"] = str(uuid.uuid4())
            self.send(202, body)

        def create(self, client):
            payload = self.body()
            key = self.headers.get("Idempotency-Key")
            if key and (client, key) in fake.idem:
                job_id = fake.idem[(client, key)]
                if "replay_new_job" in fake.faults:
                    job_id = str(uuid.uuid4())
                    fake.jobs[job_id] = {"client": client, "polls": 0, "subject": payload["subject"]}
                headers = {} if "no_replay_header" in fake.faults else {"Idempotent-Replayed": "true"}
                return self.send(202, {"job_id": job_id, "status": "queued", "status_url": f"/jobs/{job_id}"}, headers)
            job_id = str(uuid.uuid4())
            fake.jobs[job_id] = {"client": client, "polls": 0, "subject": payload["subject"]}
            if key:
                fake.idem[(client, key)] = job_id
            self.send(202, {"job_id": job_id, "status": "queued", "status_url": f"/jobs/{job_id}"})

        def job(self, job_id, name, role):
            job = fake.jobs.get(job_id)
            if job is None or (role != "reviewer" and job["client"] != name and "jobs_visible" not in fake.faults):
                return self.send(404, {"detail": "Job not found"})
            job["polls"] += 1
            if "job_fails" in fake.faults:
                return self.send(200, {"job_id": job_id, "status": "failed", "error": "triage service error (500)"})
            if "job_never_done" in fake.faults or job["polls"] <= fake.polls_before_done:
                return self.send(200, {"job_id": job_id, "status": "running"})
            if "ticket" not in job:
                job["ticket"] = fake.new_ticket(job["subject"])
            ticket = job["ticket"]
            result = {
                "ticket_id": ticket["ticket_id"],
                "reference": ticket["reference"],
                "needs_human_review": ticket["needs_human_review"] and "not_flagged" not in fake.faults,
            }
            self.send(200, {"job_id": job_id, "status": "done", "result": result})

        def do_GET(self):
            self.handle_any("GET")

        def do_POST(self):
            self.handle_any("POST")

    return Handler


@pytest.fixture
def gateway():
    fake = FakeGateway()
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(fake))
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    thread.start()
    fake.url = f"http://127.0.0.1:{server.server_address[1]}"
    yield fake
    server.shutdown()
    server.server_close()


def run(fake, capsys, other=True, extra_env=None, argv=("--interval", "0.01", "--timeout", "3"), login=False):
    env = {"E2E_BASE_URL": fake.url, "E2E_SUBMITTER_KEY": SUBMITTER_KEY, "E2E_REVIEWER_KEY": REVIEWER_KEY}
    if other:
        env["E2E_OTHER_SUBMITTER_KEY"] = OTHER_KEY
    if login:
        env["E2E_REVIEWER_EMAIL"] = REVIEWER_EMAIL
        env["E2E_REVIEWER_PASSWORD"] = REVIEWER_PASSWORD
    env.update(extra_env or {})
    code = smoke.main(list(argv), env)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def results(output):
    """{step number: PASS|FAIL|SKIP} from the report lines."""
    return {int(m.group(2)): m.group(1) for m in re.finditer(r"^\[(PASS|FAIL|SKIP)\] step (\d+):", output, re.M)}


def assert_no_key_in(*texts):
    for text in texts:
        for key in (SUBMITTER_KEY, REVIEWER_KEY, OTHER_KEY):
            # not the key, and not any 8-character piece of it
            for start in range(0, len(key) - 8):
                assert key[start:start + 8] not in text, "a piece of a key was printed"


# --- the happy path -------------------------------------------------------------------------

def test_all_steps_pass_against_a_healthy_gateway(gateway, capsys):
    code, out, err = run(gateway, capsys)

    assert code == 0, out
    # steps 1 to 9 as before; the optional login step 10 is skipped without reviewer credentials
    assert results(out) == {**{n: "PASS" for n in range(1, 10)}, 10: "SKIP", 11: "SKIP"}
    assert re.search(r"Summary: 9 passed, 0 failed, 2 skipped in \d+\.\ds", out)
    assert err == ""


def test_every_step_line_has_a_status_and_a_detail(gateway, capsys):
    _, out, _ = run(gateway, capsys)
    lines = [l for l in out.splitlines() if l.startswith("[")]
    assert len(lines) == 11
    for line in lines:
        assert re.match(r"^\[(PASS|FAIL|SKIP)\] step \d+: .+ - .+", line)


def test_the_test_tickets_are_marked_with_the_run_id_and_customer_id(gateway, capsys):
    code, out, _ = run(gateway, capsys)
    run_id = re.search(r"run ([0-9a-f]{8})", out).group(1)

    assert code == 0
    assert gateway.jobs  # tickets were created
    for job in gateway.jobs.values():
        assert job["subject"].startswith(f"[e2e {run_id}] ")
    assert f'customer_id "e2e-smoke"' in out


def test_the_fake_really_received_the_expected_sequence(gateway, capsys):
    run(gateway, capsys)
    seen = gateway.requests
    assert ("GET", "/health") in seen and ("GET", "/ready") in seen
    assert sum(1 for m, p in seen if (m, p) == ("POST", "/tickets")) == 3  # two for step 3, one for step 7
    assert any(p.endswith("/review") for _, p in seen)
    assert ("GET", "/dead-letters") in seen


def test_the_replay_step_sends_the_same_key_twice_and_a_fresh_key_each_run(gateway, capsys):
    run(gateway, capsys)
    run(gateway, capsys)
    keys = {key for (_client, key) in gateway.idem}
    assert len(keys) == 2  # one new Idempotency-Key per run


# --- the optional ownership step ------------------------------------------------------------

def test_step_5_is_skipped_without_the_other_submitters_key(gateway, capsys):
    code, out, _ = run(gateway, capsys, other=False)

    assert code == 0
    found = results(out)
    assert found[5] == "SKIP"
    assert "E2E_OTHER_SUBMITTER_KEY is not set" in out
    assert [n for n, r in found.items() if r == "PASS"] == [1, 2, 3, 4, 6, 7, 8, 9]


def test_step_5_fails_if_the_other_submitter_can_read_the_job(gateway, capsys):
    gateway.faults.add("jobs_visible")
    code, out, _ = run(gateway, capsys)
    assert code == 1
    assert results(out)[5] == "FAIL"


# --- failures and their dependants ----------------------------------------------------------

def test_a_failing_step_skips_the_steps_that_depend_on_it_and_the_rest_still_run(gateway, capsys):
    gateway.faults.add("no_replay_header")  # breaks step 3

    code, out, _ = run(gateway, capsys)

    assert code == 1
    found = results(out)
    assert found[3] == "FAIL"
    assert [found[n] for n in (4, 5, 6)] == ["SKIP", "SKIP", "SKIP"]  # all need step 3 or 4
    assert "depends on step 3" in out
    assert [found[n] for n in (1, 2, 7, 8, 9)] == ["PASS"] * 5  # independent steps still ran
    assert re.search(r"Summary: 5 passed, 1 failed, 5 skipped", out)


def test_a_dependant_of_a_skipped_step_is_skipped_too(gateway, capsys):
    gateway.faults.add("job_fails")  # step 4 (and 7) fail

    code, out, _ = run(gateway, capsys)

    found = results(out)
    assert code == 1
    assert found[4] == "FAIL" and "job failed: triage service error (500)" in out
    assert found[5] == "SKIP" and found[6] == "SKIP"
    assert "depends on step 4" in out
    assert found[7] == "FAIL" and found[8] == "SKIP"  # 8 needs 7


@pytest.mark.parametrize(
    "fault, step",
    [
        ("triage_down", 1),
        ("open_gateway", 2),
        ("replay_new_job", 3),
        ("bad_reference", 4),
        ("reads_differ", 6),
        ("not_flagged", 7),
        ("review_twice_ok", 8),
        ("no_reviewed_by", 8),
        ("wrong_reviewer", 8),
        ("submitter_allowed", 9),
    ],
)
def test_each_rule_the_script_checks_can_fail(gateway, capsys, fault, step):
    gateway.faults.add(fault)

    code, out, _ = run(gateway, capsys)

    assert code == 1
    assert results(out)[step] == "FAIL", out


def test_a_job_that_never_finishes_fails_after_the_timeout(gateway, capsys):
    gateway.faults.add("job_never_done")
    code, out, _ = run(gateway, capsys, argv=("--interval", "0.01", "--timeout", "0.3"))
    assert code == 1
    assert results(out)[4] == "FAIL"
    assert re.search(r"job still 'running' after 0\.3s", out)


def test_an_unreachable_gateway_fails_the_steps_that_can_run_and_skips_the_rest(capsys):
    code = smoke.main(
        ["--interval", "0.01", "--timeout", "1"],
        {"E2E_BASE_URL": "http://127.0.0.1:1", "E2E_SUBMITTER_KEY": SUBMITTER_KEY, "E2E_REVIEWER_KEY": REVIEWER_KEY},
    )
    out = capsys.readouterr().out
    found = results(out)
    assert code == 1
    assert {found[n] for n in (1, 2, 3, 7, 9)} == {"FAIL"}
    assert {found[n] for n in (4, 5, 6, 8)} == {"SKIP"}
    assert "cannot reach the gateway (" in out


# --- settings and exit codes ----------------------------------------------------------------

@pytest.mark.parametrize(
    "env, named",
    [
        ({}, ["E2E_SUBMITTER_KEY", "E2E_REVIEWER_KEY"]),
        ({"E2E_REVIEWER_KEY": REVIEWER_KEY}, ["E2E_SUBMITTER_KEY"]),
        ({"E2E_SUBMITTER_KEY": SUBMITTER_KEY}, ["E2E_REVIEWER_KEY"]),
        ({"E2E_SUBMITTER_KEY": "   ", "E2E_REVIEWER_KEY": REVIEWER_KEY}, ["E2E_SUBMITTER_KEY"]),
    ],
)
def test_missing_required_keys_exit_with_2_naming_them_and_nothing_else_runs(capsys, env, named):
    code = smoke.main([], env)
    captured = capsys.readouterr()

    assert code == 2
    for name in named:
        assert name in captured.err
    assert captured.out == ""
    assert_no_key_in(captured.out, captured.err)


def test_a_missing_optional_key_is_not_an_error(gateway, capsys):
    code, _, _ = run(gateway, capsys, other=False)
    assert code == 0


def test_a_base_url_that_is_not_http_exits_with_2(capsys):
    code = smoke.main([], {"E2E_BASE_URL": "ftp://x", "E2E_SUBMITTER_KEY": "a", "E2E_REVIEWER_KEY": "b"})
    assert code == 2
    assert "E2E_BASE_URL" in capsys.readouterr().err


def test_the_default_base_url_is_localhost_3000():
    assert smoke.DEFAULT_BASE_URL == "http://localhost:3000"


# --- keys are never printed -----------------------------------------------------------------

@pytest.mark.parametrize(
    "faults",
    [set(), {"no_replay_header"}, {"job_fails"}, {"open_gateway", "triage_down"}, {"reads_differ", "not_flagged"}],
)
def test_no_key_appears_in_any_output_not_even_in_part(gateway, capsys, faults):
    gateway.faults |= faults
    code, out, err = run(gateway, capsys)
    assert code in (0, 1)
    assert_no_key_in(out, err)
    assert "Bearer" not in out + err


def test_no_key_appears_when_the_gateway_is_unreachable(capsys):
    smoke.main(
        ["--interval", "0.01", "--timeout", "1"],
        {"E2E_BASE_URL": "http://127.0.0.1:1", "E2E_SUBMITTER_KEY": SUBMITTER_KEY, "E2E_REVIEWER_KEY": REVIEWER_KEY, "E2E_OTHER_SUBMITTER_KEY": OTHER_KEY},
    )
    captured = capsys.readouterr()
    assert_no_key_in(captured.out, captured.err)


# --- the script is self-contained -----------------------------------------------------------

def test_the_script_uses_only_the_standard_library_and_imports_nothing_from_the_project():
    source = SCRIPT.read_text()
    imported = set(re.findall(r"^(?:import|from) ([a-zA-Z_]+)", source, re.M))
    stdlib_only = {"argparse", "json", "os", "re", "sys", "time", "urllib", "uuid", "typing"}
    assert imported <= stdlib_only, imported - stdlib_only
    assert not re.search(r"^(?:from|import) (?:app|gateway)\b", source, re.M)


def test_the_script_is_runnable_and_documents_its_settings():
    source = SCRIPT.read_text()
    assert source.startswith("#!/usr/bin/env python3")
    for name in ("E2E_BASE_URL", "E2E_SUBMITTER_KEY", "E2E_REVIEWER_KEY", "E2E_OTHER_SUBMITTER_KEY"):
        assert name in source


# --- the optional session-cookie login step (10) -----------------------------------------------

def test_step_10_is_skipped_cleanly_without_reviewer_credentials(gateway, capsys):
    code, out, _ = run(gateway, capsys)
    assert code == 0
    assert results(out)[10] == "SKIP"
    assert "E2E_REVIEWER_EMAIL and E2E_REVIEWER_PASSWORD are not set" in out
    assert not any(path.startswith("/auth/") for _, path in gateway.requests)  # nothing was even tried


@pytest.mark.parametrize("only", ["E2E_REVIEWER_EMAIL", "E2E_REVIEWER_PASSWORD"])
def test_step_10_needs_both_the_email_and_the_password(gateway, capsys, only):
    value = REVIEWER_EMAIL if only == "E2E_REVIEWER_EMAIL" else REVIEWER_PASSWORD
    code, out, _ = run(gateway, capsys, extra_env={only: value})
    assert code == 0
    assert results(out)[10] == "SKIP"


def test_all_ten_steps_pass_with_reviewer_credentials(gateway, capsys):
    code, out, err = run(gateway, capsys, login=True)

    assert code == 0, out
    assert results(out) == {**{n: "PASS" for n in range(1, 11)}, 11: "SKIP"}
    assert re.search(r"Summary: 10 passed, 0 failed, 1 skipped", out)
    assert err == ""


def test_step_10_logs_in_with_an_origin_uses_the_cookie_and_logs_out(gateway, capsys):
    run(gateway, capsys, login=True)
    auth = [(m, p) for m, p in gateway.requests if p.startswith("/auth/")]
    assert auth == [("POST", "/auth/login"), ("GET", "/auth/me"), ("POST", "/auth/logout"), ("GET", "/auth/me")]
    assert ("GET", "/tickets") in gateway.requests
    assert gateway.sessions == {}  # logged out


def test_step_10_sends_the_configured_origin(gateway, capsys):
    gateway.allowed_origins = {"https://reviews.example.org"}
    code, out, _ = run(gateway, capsys, login=True, extra_env={"E2E_ORIGIN": "https://reviews.example.org"})
    assert code == 0 and results(out)[10] == "PASS"


def test_step_10_fails_when_the_origin_is_not_allowed(gateway, capsys):
    gateway.allowed_origins = {"https://somewhere.else"}
    code, out, _ = run(gateway, capsys, login=True)
    assert code == 1
    assert results(out)[10] == "FAIL"
    assert "expected 200, got 403" in out


def test_step_10_fails_with_a_wrong_password(gateway, capsys):
    code, out, _ = run(gateway, capsys, login=True, extra_env={"E2E_REVIEWER_PASSWORD": "not the right one 123"})
    assert code == 1
    assert results(out)[10] == "FAIL"
    assert "expected 200, got 401" in out


@pytest.mark.parametrize("fault, text", [("cookie_no_httponly", "httponly"), ("cookie_lax", "samesite=strict")])
def test_step_10_checks_the_cookie_attributes(gateway, capsys, fault, text):
    gateway.faults.add(fault)
    code, out, _ = run(gateway, capsys, login=True)
    assert code == 1
    assert results(out)[10] == "FAIL"
    assert text in out


def test_step_10_fails_if_the_session_survives_logout(gateway, capsys):
    gateway.faults.add("logout_keeps_session")
    code, out, _ = run(gateway, capsys, login=True)
    assert code == 1
    assert results(out)[10] == "FAIL"
    assert "after logout" in out and "expected 401, got 200" in out


def test_a_failing_step_10_does_not_affect_the_nine_before_it(gateway, capsys):
    gateway.faults.add("logout_keeps_session")
    _, out, _ = run(gateway, capsys, login=True)
    assert {n: results(out)[n] for n in range(1, 10)} == {n: "PASS" for n in range(1, 10)}


def test_the_password_and_the_session_cookie_are_never_printed(gateway, capsys):
    for faults in (set(), {"logout_keeps_session"}, {"cookie_lax"}):
        gateway.faults = set(faults)
        code, out, err = run(gateway, capsys, login=True)
        assert code in (0, 1)
        assert REVIEWER_PASSWORD not in out + err
        assert "typed-by-a-human" not in out + err
        assert (gateway.last_token or "@@") not in out + err
        assert "tiq_session" not in out + err
        assert_no_key_in(out, err)


def test_the_script_documents_the_new_settings():
    source = SCRIPT.read_text()
    for name in ("E2E_REVIEWER_EMAIL", "E2E_REVIEWER_PASSWORD", "E2E_ORIGIN"):
        assert name in source


# --- step 8 also checks who decided the review ---------------------------------------------

def test_step_8_checks_the_review_is_recorded_as_the_reviewer_client(gateway, capsys):
    code, out, _ = run(gateway, capsys)
    assert code == 0
    assert results(out)[8] == "PASS"
    assert "reviewed_by client:ops" in out
    (ticket,) = [t for t in gateway.tickets.values() if t["status"] == "edited"]
    assert ticket["reviewed_by"] == {"id": "client:ops", "name": "ops"}


def test_step_8_fails_when_the_ticket_has_no_reviewed_by(gateway, capsys):
    gateway.faults.add("no_reviewed_by")
    code, out, _ = run(gateway, capsys)
    assert code == 1
    assert results(out)[8] == "FAIL"
    assert "reviewed_by.id is not client:ops" in out


def test_step_8_fails_when_the_wrong_reviewer_is_recorded(gateway, capsys):
    gateway.faults.add("wrong_reviewer")
    code, out, _ = run(gateway, capsys)
    assert code == 1 and results(out)[8] == "FAIL"


def test_step_8_uses_the_configured_reviewer_client_name(gateway, capsys):
    code, out, _ = run(gateway, capsys, extra_env={"E2E_REVIEWER_CLIENT": "ops"})
    assert code == 0 and results(out)[8] == "PASS"
    # a name that is not the key's client is a mismatch
    code, out, _ = run(gateway, capsys, extra_env={"E2E_REVIEWER_CLIENT": "alice"})
    assert code == 1 and results(out)[8] == "FAIL" and "client:alice" in out


def test_the_script_documents_the_reviewer_client_setting():
    assert "E2E_REVIEWER_CLIENT" in SCRIPT.read_text()



# --- step 11: the public form -----------------------------------------------------------------

def test_step_11_is_skipped_unless_E2E_PUBLIC_FORM_is_1(gateway, capsys):
    code, out, _ = run(gateway, capsys)
    assert results(out)[11] == "SKIP" and "E2E_PUBLIC_FORM=1" in out
    assert gateway.public_calls == []  # no real submission without the switch
    assert code == 0


def test_step_11_submits_with_the_dummy_token_and_origin_then_the_reviewer_reads_the_contact_details(gateway, capsys):
    code, out, _ = run(gateway, capsys, extra_env={"E2E_PUBLIC_FORM": "1"})

    assert code == 0, out
    assert results(out)[11] == "PASS"
    headers, body = gateway.public_calls[0]
    assert body["turnstile_token"] == "XXXX.DUMMY.TOKEN.XXXX"
    assert headers["Origin"] == ALLOWED_ORIGIN
    assert headers["Idempotency-Key"].startswith("e2e-")
    assert "Authorization" not in headers  # the public route needs no key
    assert set(body) == {"name", "email", "subject", "message", "turnstile_token"}
    assert body["subject"].startswith("[e2e ")
    assert ("POST", "/public/tickets") in gateway.requests


def test_step_11_polls_until_the_ticket_exists(gateway, capsys):
    gateway.public_reads_before_found = 3
    code, out, _ = run(gateway, capsys, extra_env={"E2E_PUBLIC_FORM": "1"})
    assert results(out)[11] == "PASS", out
    assert [r for r in gateway.requests if r[1].startswith("/tickets/reference/")].__len__() >= 4


@pytest.mark.parametrize(
    "fault, text",
    [
        ("public_disabled", "expected 202, got 404"),
        ("public_leaks_job_id", "only a reference and a message"),
        ("email_not_lowercased", "customer_email did not round-trip"),
    ],
)
def test_step_11_fails_when_the_public_form_misbehaves(gateway, capsys, fault, text):
    gateway.faults.add(fault)
    code, out, _ = run(gateway, capsys, extra_env={"E2E_PUBLIC_FORM": "1"})
    assert code == 1
    assert results(out)[11] == "FAIL" and text in out


def test_step_11_fails_with_a_wrong_origin_and_does_not_affect_the_steps_before_it(gateway, capsys):
    code, out, _ = run(gateway, capsys, extra_env={"E2E_PUBLIC_FORM": "1", "E2E_ORIGIN": "http://evil.example"})
    found = results(out)
    assert found[11] == "FAIL" and "got 403" in out
    assert all(found[n] == "PASS" for n in range(1, 10))


def test_the_script_documents_the_public_form_setting():
    text = open(smoke.__file__).read()
    assert "E2E_PUBLIC_FORM" in text and "one model call" in text.lower()
