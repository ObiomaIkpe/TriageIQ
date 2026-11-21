#!/usr/bin/env python3
"""End-to-end smoke test for a running TriageIQ stack, driven through the gateway.

It uses only the Python standard library and imports nothing from app/ or gateway/.
It creates real tickets, so it costs model calls: run it yourself against the stack you
want to check. Every ticket it creates has a subject starting with "[e2e <run id>]" and the
customer_id "e2e-smoke", so they are easy to find afterwards.

Settings (environment variables):
  E2E_BASE_URL               gateway address (default http://localhost:3000)
  E2E_SUBMITTER_KEY          API key of a client with the "submitter" role (required)
  E2E_REVIEWER_KEY           API key of a client with the "reviewer" role (required)
  E2E_OTHER_SUBMITTER_KEY    key of a second submitter; enables the ownership step (optional)
  E2E_REVIEWER_CLIENT        the NAME of the API client that E2E_REVIEWER_KEY belongs to (default "ops"); step 8
                             checks the review is recorded as "client:<name>"
  E2E_REVIEWER_EMAIL         a reviewer account's email, together with ...
  E2E_REVIEWER_PASSWORD      ... its password: enables the session-cookie login step (optional)
  E2E_ORIGIN                 the Origin to send with login and logout (default http://localhost:5173;
                             it must be one of the gateway's ALLOWED_ORIGINS)

  E2E_PUBLIC_FORM            set to 1 to also run step 11, the public ticket form (POST /public/tickets). OFF by default.
                             It needs the gateway to run with PUBLIC_FORM_ENABLED=true and Cloudflare's DUMMY Turnstile
                             secret (see gateway/.env.example), and it COSTS ONE MODEL CALL SET (one real ticket). It
                             sends Cloudflare's dummy token, so a gateway with a real secret refuses it (step 11 fails).

A key, a password or a session cookie is never printed, not even in part. Exit code: 0 nothing failed, 1 something failed,
2 a required setting is missing or invalid.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
from typing import Callable, Optional

DEFAULT_BASE_URL = "http://localhost:3000"
DEFAULT_ORIGIN = "http://localhost:5173"
SESSION_COOKIE = "tiq_session"
REFERENCE_PATTERN = re.compile(r"^TKT-[A-Z2-9]{6}$")
CUSTOMER_ID = "e2e-smoke"
# Cloudflare's documented dummy token: accepted only by its dummy secrets, rejected by a real one.
TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX"
REQUEST_TIMEOUT_SECONDS = 60
EXIT_OK, EXIT_FAILED, EXIT_BAD_SETTINGS = 0, 1, 2


class Failed(Exception):
    """A step did not get what it expected. The message goes in the report: no keys in it."""


class Skipped(Exception):
    """A step cannot run for a reason that is not a failure."""


class Reply:
    def __init__(self, status: int, headers: dict, body, set_cookies=None):
        self.status = status
        self.headers = headers  # lower-case names
        self.body = body  # parsed JSON, or None if the body was empty or not JSON
        self.set_cookies = set_cookies or []  # every Set-Cookie header, as sent


class Gateway:
    """Minimal HTTP client. Keys are only ever put in the Authorization header."""

    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    def request(
        self,
        method: str,
        path: str,
        key: Optional[str] = None,
        body=None,
        headers: Optional[dict] = None,
    ) -> Reply:
        sent = {"Accept": "application/json"}
        if key:
            sent["Authorization"] = f"Bearer {key}"
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            sent["Content-Type"] = "application/json"
        sent.update(headers or {})
        request = urllib.request.Request(self.base_url + path, data=data, method=method, headers=sent)
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
                return self._reply(response.status, response.headers, response.read())
        except urllib.error.HTTPError as error:  # a 4xx or 5xx is an answer, not a failure
            with error:
                return self._reply(error.code, error.headers, error.read())
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            # Only the kind of error: its text can contain the address and nothing useful.
            raise Failed(f"cannot reach the gateway ({type(error).__name__})") from None

    @staticmethod
    def _reply(status: int, raw_headers, raw_body: bytes) -> Reply:
        headers = {name.lower(): value for name, value in raw_headers.items()}
        try:
            body = json.loads(raw_body) if raw_body else None
        except ValueError:
            body = None
        return Reply(status, headers, body, raw_headers.get_all("Set-Cookie") or [])


def expect_status(reply: Reply, wanted: int, what: str) -> None:
    if reply.status != wanted:
        raise Failed(f"{what}: expected {wanted}, got {reply.status}")


class Smoke:
    def __init__(self, gateway: Gateway, keys: dict, run_id: str, timeout: float, interval: float):
        self.gateway = gateway
        self.keys = keys  # submitter, reviewer, other (may be None)
        self.run_id = run_id
        self.timeout = timeout
        self.interval = interval
        self.state: dict = {}  # values one step hands to the steps that depend on it

    # ---- helpers -------------------------------------------------------------------------

    def subject(self, text: str) -> str:
        return f"[e2e {self.run_id}] {text}"

    def post_ticket(self, subject: str, body: str, idempotency_key: Optional[str] = None) -> Reply:
        extra = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return self.gateway.request(
            "POST",
            "/tickets",
            self.keys["submitter"],
            {"subject": subject, "body": body, "customer_id": CUSTOMER_ID},
            extra,
        )

    def wait_for_job(self, job_id: str) -> dict:
        """Poll until the job is done or failed, or the timeout passes."""
        deadline = time.monotonic() + self.timeout
        status = "unknown"
        while True:
            reply = self.gateway.request("GET", f"/jobs/{job_id}", self.keys["submitter"])
            expect_status(reply, 200, "GET /jobs/<id>")
            body = reply.body or {}
            status = body.get("status", "unknown")
            if status == "done":
                return body
            if status == "failed":
                # The gateway's own short reason ("timeout", "triage service unavailable (503)").
                raise Failed(f"job failed: {str(body.get('error', 'no reason given'))[:120]}")
            if time.monotonic() >= deadline:
                raise Failed(f"job still '{status}' after {self.timeout:g}s")
            time.sleep(self.interval)

    # ---- steps ---------------------------------------------------------------------------

    def step_health_and_ready(self) -> str:
        health = self.gateway.request("GET", "/health")
        expect_status(health, 200, "GET /health")
        ready = self.gateway.request("GET", "/ready")
        expect_status(ready, 200, "GET /ready")
        checks = (ready.body or {}).get("checks", {})
        if checks.get("redis") != "ok" or checks.get("triage") != "ok":
            raise Failed(f"/ready checks are not both ok: redis={checks.get('redis')}, triage={checks.get('triage')}")
        return "/health 200; /ready 200 with redis ok and triage ok"

    def step_no_key_is_refused(self) -> str:
        reply = self.gateway.request("GET", f"/jobs/{uuid.uuid4()}")
        expect_status(reply, 401, "GET /jobs/<id> without a key")
        return "401 without a key"

    def step_submit_and_replay(self) -> str:
        key = f"e2e-{self.run_id}-{uuid.uuid4().hex[:12]}"
        subject = self.subject("Password reset")
        body = "I forgot my password. How do I reset it?"
        first = self.post_ticket(subject, body, key)
        expect_status(first, 202, "POST /tickets")
        job_id = (first.body or {}).get("job_id")
        if not job_id:
            raise Failed("the 202 answer has no job_id")
        self.state["job_id"] = job_id
        second = self.post_ticket(subject, body, key)
        expect_status(second, 202, "POST /tickets again with the same Idempotency-Key")
        if (second.body or {}).get("job_id") != job_id:
            raise Failed("the same Idempotency-Key gave a different job_id")
        if second.headers.get("idempotent-replayed") != "true":
            raise Failed("the repeated request has no 'Idempotent-Replayed: true' header")
        return f"202, then 202 with the same job_id and Idempotent-Replayed: true (job {job_id})"

    def step_job_done(self) -> str:
        job = self.wait_for_job(self.state["job_id"])
        result = job.get("result") or {}
        ticket_id, reference = result.get("ticket_id"), result.get("reference")
        if not ticket_id:
            raise Failed("the result has no ticket_id")
        if not isinstance(reference, str) or not REFERENCE_PATTERN.match(reference):
            raise Failed("the result's reference does not look like TKT-XXXXXX")
        self.state["ticket_id"], self.state["reference"] = ticket_id, reference
        return f"job done; ticket {ticket_id}, reference {reference}"

    def step_other_submitter_gets_404(self) -> str:
        if not self.keys["other"]:
            raise Skipped("E2E_OTHER_SUBMITTER_KEY is not set")
        reply = self.gateway.request("GET", f"/jobs/{self.state['job_id']}", self.keys["other"])
        expect_status(reply, 404, "another submitter reading this job")
        return "another submitter gets 404 for this job"

    def step_reviewer_reads(self) -> str:
        by_id = self.gateway.request("GET", f"/tickets/{self.state['ticket_id']}", self.keys["reviewer"])
        expect_status(by_id, 200, "GET /tickets/<id>")
        by_ref = self.gateway.request("GET", f"/tickets/reference/{self.state['reference']}", self.keys["reviewer"])
        expect_status(by_ref, 200, "GET /tickets/reference/<reference>")
        if by_id.body != by_ref.body:
            raise Failed("the two reads returned different tickets")
        if (by_id.body or {}).get("ticket_id") != self.state["ticket_id"]:
            raise Failed("the ticket read back is not the one that was created")
        return "reviewer reads the same ticket by id and by reference (200, 200)"

    def step_vague_ticket_needs_review(self) -> str:
        reply = self.post_ticket(self.subject("Help"), "It does not work.")
        expect_status(reply, 202, "POST /tickets (vague ticket)")
        job_id = (reply.body or {}).get("job_id")
        if not job_id:
            raise Failed("the 202 answer has no job_id")
        result = (self.wait_for_job(job_id).get("result")) or {}
        if result.get("needs_human_review") is not True:
            raise Failed("the vague ticket was not flagged for human review")
        if not result.get("ticket_id"):
            raise Failed("the result has no ticket_id")
        self.state["flagged_ticket_id"] = result["ticket_id"]
        return f"vague ticket done and flagged for human review (ticket {result['ticket_id']})"

    def step_review_once_then_conflict(self) -> str:
        path = f"/tickets/{self.state['flagged_ticket_id']}/review"
        decision = {"action": "edit", "edited_reply": "[e2e] reviewed by smoke test"}
        first = self.gateway.request("POST", path, self.keys["reviewer"], decision)
        expect_status(first, 200, "POST review")
        if (first.body or {}).get("status") != "edited":
            raise Failed(f"the reviewed ticket's status is {(first.body or {}).get('status')!r}, not 'edited'")
        # Who decided is recorded by the system from the key that was used: "client:<name>" of the API client.
        wanted = f"client:{self.keys['reviewer_client']}"
        reviewed_by = (first.body or {}).get("reviewed_by")
        if not isinstance(reviewed_by, dict) or reviewed_by.get("id") != wanted:
            raise Failed(f"the review answer's reviewed_by.id is not {wanted}")
        stored = self.gateway.request("GET", f"/tickets/{self.state['flagged_ticket_id']}", self.keys["reviewer"])
        expect_status(stored, 200, "GET /tickets/<id> after the review")
        if ((stored.body or {}).get("reviewed_by") or {}).get("id") != wanted:
            raise Failed(f"the stored ticket's reviewed_by.id is not {wanted}")
        again = self.gateway.request("POST", path, self.keys["reviewer"], decision)
        expect_status(again, 409, "POST the same review again")
        return f"review accepted (200, status edited, reviewed_by {wanted}, also on the stored ticket); the same review again gives 409"

    def step_submitter_is_forbidden(self) -> str:
        tickets = self.gateway.request("GET", "/tickets", self.keys["submitter"])
        expect_status(tickets, 403, "submitter GET /tickets")
        dead = self.gateway.request("GET", "/dead-letters", self.keys["submitter"])
        expect_status(dead, 403, "submitter GET /dead-letters")
        return "submitter gets 403 on /tickets and /dead-letters"

    def step_reviewer_session(self) -> str:
        email, password = self.keys["reviewer_email"], self.keys["reviewer_password"]
        if not email or not password:
            raise Skipped("E2E_REVIEWER_EMAIL and E2E_REVIEWER_PASSWORD are not set")
        origin = {"Origin": self.keys["origin"]}

        login = self.gateway.request("POST", "/auth/login", body={"email": email, "password": password}, headers=origin)
        expect_status(login, 200, "POST /auth/login")
        line = next((c for c in login.set_cookies if c.startswith(SESSION_COOKIE + "=")), None)
        if line is None:
            raise Failed("the login answer sets no session cookie")
        attributes = [part.strip().lower() for part in line.split(";")[1:]]
        for wanted in ("httponly", "samesite=strict"):
            if wanted not in attributes:
                raise Failed(f"the session cookie lacks {wanted}")
        cookie = {"Cookie": line.split(";")[0]}  # never printed

        me = self.gateway.request("GET", "/auth/me", headers=cookie)
        expect_status(me, 200, "GET /auth/me with the cookie")
        if str(((me.body or {}).get("user") or {}).get("email", "")).lower() != email.lower():
            raise Failed("/auth/me returned a different user than the one that logged in")
        tickets = self.gateway.request("GET", "/tickets?limit=1", headers=cookie)
        expect_status(tickets, 200, "GET /tickets with the cookie")

        logout = self.gateway.request("POST", "/auth/logout", headers={**cookie, **origin})
        expect_status(logout, 204, "POST /auth/logout")
        after = self.gateway.request("GET", "/auth/me", headers=cookie)
        expect_status(after, 401, "GET /auth/me after logout")
        return "login sets an HttpOnly SameSite=Strict cookie; /auth/me and GET /tickets work with it; after logout /auth/me is 401"

    def step_public_form(self) -> str:
        if not self.keys.get("public_form"):
            raise Skipped("set E2E_PUBLIC_FORM=1 to run it (it creates one real ticket: one model call set)")
        email = f"E2E-Smoke+{self.run_id}@Example.com"  # mixed case on purpose: it is stored lower-cased
        name = "E2E Smoke Ọbiọma"
        reply = self.gateway.request(
            "POST",
            "/public/tickets",
            None,
            {
                "name": name,
                "email": email,
                "subject": self.subject("Public form: where is my invoice?"),
                "message": "Hello, I cannot find the invoice for my last order. Could you resend it?",
                "turnstile_token": TURNSTILE_DUMMY_TOKEN,
            },
            {"Origin": self.keys["origin"], "Idempotency-Key": f"e2e-{self.run_id}"},
        )
        expect_status(reply, 202, "POST /public/tickets")
        body = reply.body or {}
        reference = body.get("reference")
        if not isinstance(reference, str) or not REFERENCE_PATTERN.match(reference):
            raise Failed("the 202 answer has no valid reference")
        if set(body) != {"reference", "message"}:
            raise Failed("the public answer must hold only a reference and a message (nothing about processing)")

        # The ticket exists once the job has run: poll as the reviewer until it is there.
        deadline = time.monotonic() + self.timeout
        while True:
            read = self.gateway.request("GET", f"/tickets/reference/{reference}", self.keys["reviewer"])
            if read.status == 200:
                break
            if read.status != 404:
                raise Failed(f"GET /tickets/reference/<reference>: expected 200 or 404, got {read.status}")
            if time.monotonic() >= deadline:
                raise Failed(f"the ticket was still not there after {self.timeout:g}s")
            time.sleep(self.interval)
        ticket = read.body or {}
        if ticket.get("customer_email") != email.lower():
            raise Failed("customer_email did not round-trip (expected the trimmed, lower-cased address)")
        if ticket.get("customer_name") != name:
            raise Failed("customer_name did not round-trip")
        if ticket.get("customer_id") != "public-form":
            raise Failed('customer_id is not "public-form"')
        return f"202 with reference {reference}; the reviewer reads it back with customer_name and customer_email intact"

    # (number, name, function, steps it needs to have passed)
    def steps(self) -> list:
        return [
            (1, "health and readiness", self.step_health_and_ready, []),
            (2, "a request without a key is refused", self.step_no_key_is_refused, []),
            (3, "submit a ticket, then repeat it with the same Idempotency-Key", self.step_submit_and_replay, []),
            (4, "the job finishes and has a ticket and a reference", self.step_job_done, [3]),
            (5, "another submitter cannot read the job", self.step_other_submitter_gets_404, [4]),
            (6, "the reviewer reads the ticket by id and by reference", self.step_reviewer_reads, [4]),
            (7, "a vague ticket is flagged for human review", self.step_vague_ticket_needs_review, []),
            (8, "the reviewer reviews it once; a second review is refused", self.step_review_once_then_conflict, [7]),
            (9, "a submitter cannot use the reviewer routes", self.step_submitter_is_forbidden, []),
            (10, "a reviewer logs in with a session cookie, uses it, and logs out", self.step_reviewer_session, []),
            (11, "the public form takes a ticket (E2E_PUBLIC_FORM=1; costs one model call set)", self.step_public_form, []),
        ]

    def run(self, out: Callable[[str], None]) -> int:
        outcome: dict = {}
        counts = {"PASS": 0, "FAIL": 0, "SKIP": 0}
        started = time.monotonic()
        for number, name, function, needs in self.steps():
            blocked = [n for n in needs if outcome.get(n) != "PASS"]
            if blocked:
                result, detail = "SKIP", f"depends on step {blocked[0]}"
            else:
                try:
                    result, detail = "PASS", function()
                except Skipped as skipped:
                    result, detail = "SKIP", str(skipped)
                except Failed as failure:
                    result, detail = "FAIL", str(failure)
                except Exception as error:  # a bug in this script or something unexpected
                    result, detail = "FAIL", f"unexpected error ({type(error).__name__})"
            outcome[number] = result
            counts[result] += 1
            out(f"[{result}] step {number}: {name} - {detail}")
        elapsed = time.monotonic() - started
        out(
            f"Summary: {counts['PASS']} passed, {counts['FAIL']} failed, "
            f"{counts['SKIP']} skipped in {elapsed:.1f}s (run {self.run_id})"
        )
        return EXIT_FAILED if counts["FAIL"] else EXIT_OK


def main(argv=None, env=None, out: Callable[[str], None] = print) -> int:
    parser = argparse.ArgumentParser(description="End-to-end smoke test through the gateway.")
    parser.add_argument("--timeout", type=float, default=180, help="seconds to wait for a job (default 180)")
    parser.add_argument("--interval", type=float, default=3, help="seconds between job polls (default 3)")
    args = parser.parse_args(argv)
    env = os.environ if env is None else env

    submitter = (env.get("E2E_SUBMITTER_KEY") or "").strip()
    reviewer = (env.get("E2E_REVIEWER_KEY") or "").strip()
    other = (env.get("E2E_OTHER_SUBMITTER_KEY") or "").strip() or None
    missing = [
        name
        for name, value in (("E2E_SUBMITTER_KEY", submitter), ("E2E_REVIEWER_KEY", reviewer))
        if not value
    ]
    if missing:
        print(f"Missing required environment variables: {', '.join(missing)}", file=sys.stderr)
        return EXIT_BAD_SETTINGS
    reviewer_email = (env.get("E2E_REVIEWER_EMAIL") or "").strip() or None
    reviewer_password = env.get("E2E_REVIEWER_PASSWORD") or None  # not stripped: spaces can be part of a password
    origin = (env.get("E2E_ORIGIN") or DEFAULT_ORIGIN).strip()
    base_url = (env.get("E2E_BASE_URL") or DEFAULT_BASE_URL).strip()
    if not base_url.startswith(("http://", "https://")):
        print("E2E_BASE_URL must start with http:// or https://", file=sys.stderr)
        return EXIT_BAD_SETTINGS

    run_id = uuid.uuid4().hex[:8]
    out(f"E2E smoke test against {base_url} (run {run_id}).")
    out(f'Test tickets are marked with a subject starting "[e2e {run_id}]" and customer_id "{CUSTOMER_ID}".')
    smoke = Smoke(
        Gateway(base_url),
        {
            "submitter": submitter,
            "reviewer": reviewer,
            "other": other,
            "reviewer_client": (env.get("E2E_REVIEWER_CLIENT") or "ops").strip(),
            "reviewer_email": reviewer_email,
            "reviewer_password": reviewer_password,
            "origin": origin,
            "public_form": (env.get("E2E_PUBLIC_FORM") or "").strip() == "1",
        },
        run_id,
        args.timeout,
        args.interval,
    )
    return smoke.run(out)


if __name__ == "__main__":
    sys.exit(main())
