"""The example tickets: their shape, without a database or a model."""
import re
from datetime import datetime, timezone

from app.demo import seed
from app.kb.ingest import SAMPLE_DOCS
from app.models import Category, TicketStatus, Urgency
from app.tickets.reference import REFERENCE_PATTERN

NOW = datetime(2026, 11, 24, 12, 0, tzinfo=timezone.utc)
ROWS = seed.build_rows(NOW)
BY = {example.slug: values for example, values in zip(seed.EXAMPLES, ROWS)}


def test_there_are_eight_examples_covering_every_status():
    assert len(ROWS) == 8
    statuses = sorted(row["status"] for row in ROWS)
    assert statuses == sorted(["pending_review"] * 4 + ["triaged", "approved", "edited", "rejected"])


def test_every_example_is_a_demo_ticket_with_a_fake_customer():
    for row in ROWS:
        assert row["is_demo"] is True
        assert row["customer_email"].endswith("@example.com")
        assert re.fullmatch(REFERENCE_PATTERN, row["reference"])


def test_ids_and_references_are_fixed_and_unique():
    again = seed.build_rows(NOW)
    assert [r["id"] for r in again] == [r["id"] for r in ROWS]
    assert [r["reference"] for r in again] == [r["reference"] for r in ROWS]
    assert len({r["id"] for r in ROWS}) == 8 and len({r["reference"] for r in ROWS}) == 8


def test_the_knowledge_base_articles_are_the_real_ones():
    real = {d["topic"]: d["content"] for d in SAMPLE_DOCS}
    shown = [source for row in ROWS for source in row["kb_sources"]]
    assert shown, "at least one example shows articles"
    for source in shown:
        assert source["content"] == real[source["topic"]]


def test_the_scenarios_the_demo_promises_are_there():
    lockout = BY["lockout-unsupported-advice"]
    assert lockout["status"] == "pending_review" and lockout["category"] == "account"
    assert "removes the lock immediately" in lockout["suggested_reply"]  # the unsupported advice
    assert "clears automatically after 1 hour" in lockout["kb_sources"][0]["content"]  # ... which the article does not say

    vague = BY["vague-help"]
    assert vague["status"] == "pending_review" and vague["category"] == "other" and vague["suggested_reply"] is None

    injection = BY["prompt-injection-refund"]
    assert injection["status"] == "pending_review" and injection["review_reason"] == "Possible prompt injection in the ticket."
    assert "ignore all previous instructions" in injection["body"]

    no_kb = BY["billing-no-kb-match"]
    assert no_kb["status"] == "pending_review" and no_kb["category"] == "billing"
    assert no_kb["kb_sources"] == [] and no_kb["suggested_reply"] is None

    auto = BY["auto-password-reset"]
    assert auto["status"] == "triaged" and auto["needs_human_review"] is False and auto["review_reason"] is None
    assert "30 minutes" in auto["suggested_reply"] and auto["kb_sources"][0]["topic"] == "password reset"


def test_the_decided_examples_are_reviewed_by_the_demo_reviewer():
    for slug, status in (("approved-billing-date", "approved"), ("edited-cancellation", "edited"), ("rejected-not-support", "rejected")):
        row = BY[slug]
        assert row["status"] == status
        assert row["reviewed_by_name"] == "Demo Reviewer" and row["reviewed_by_id"] == seed.DEMO_REVIEWER_ID
        assert row["reviewed_at"] > row["created_at"]
    assert BY["approved-billing-date"]["final_reply"] == BY["approved-billing-date"]["suggested_reply"]
    assert BY["edited-cancellation"]["final_reply"] != BY["edited-cancellation"]["suggested_reply"]
    assert BY["rejected-not-support"]["final_reply"] is None


def test_undecided_examples_have_no_reviewer():
    for slug in ("lockout-unsupported-advice", "vague-help", "prompt-injection-refund", "billing-no-kb-match", "auto-password-reset"):
        row = BY[slug]
        assert row["reviewed_by_id"] is None and row["reviewed_at"] is None and row["final_reply"] is None


def test_times_are_spread_over_the_last_hours_relative_to_now():
    created = sorted(r["created_at"] for r in ROWS)
    assert created[-1] < NOW and (NOW - created[0]).total_seconds() <= 6 * 3600
    assert (created[-1] - created[0]).total_seconds() > 3 * 3600


def test_the_values_are_ones_the_model_layer_accepts():
    for row in ROWS:
        Category(row["category"]); Urgency(row["urgency"]); TicketStatus(row["status"])
        assert 0.0 <= row["confidence"] <= 1.0


def test_text_is_plain_no_markdown():
    markers = ("**", "##", "```", "](", "\n- ", "\n* ")
    for row in ROWS:
        for text in (row["subject"], row["body"], row["suggested_reply"] or "", row["final_reply"] or "", row["review_reason"] or "", row["review_note"] or ""):
            assert not any(m in text for m in markers), (row["reference"], text[:60])
