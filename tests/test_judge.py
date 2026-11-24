"""The groundedness judge (evals/judge/judge.py): output validation, the quote check, the verdict.
No API calls: answers come from recorded fixtures through a fake backend."""
import json
from pathlib import Path

import pytest

from evals.judge.judge import (
    SYSTEM_PROMPT, JudgeOutput, RawAnswer, build_user_message, evaluate, judge_draft, normalise,
    quote_in_articles, resolve_model,
)

FIX = Path(__file__).parent / "fixtures" / "judge"


def fixture(name):
    data = json.loads((FIX / f"{name}.json").read_text())
    return data["answer"], [{"topic": "account lockout", "content": data["article"]}]


class FakeBackend:
    model = "fake-judge"

    def __init__(self, payload=None, error=None):
        self.payload, self.error, self.seen = payload, error, []

    def complete(self, system, user):
        self.seen.append((system, user))
        return RawAnswer(payload=self.payload, error=self.error, input_tokens=100, output_tokens=20)


def test_grounded_fixture_is_grounded_and_every_quote_verifies():
    answer, arts = fixture("grounded")
    res = evaluate(RawAnswer(payload=answer), arts)
    assert res.verdict == "grounded" and res.error is None
    assert [c.final_label for c in res.claims] == ["not_a_claim", "supported", "supported", "not_a_claim"]
    assert res.quote_errors == [] and not res.verdict_mismatch


def test_unsupported_claim_makes_it_not_grounded():
    answer, arts = fixture("drift")
    res = evaluate(RawAnswer(payload=answer), arts)
    assert res.verdict == "not_grounded" and res.quote_errors == []


def test_supported_claim_with_a_quote_not_in_the_article_is_a_judge_error_and_counts_unsupported():
    answer, arts = fixture("bad_quote")
    res = evaluate(RawAnswer(payload=answer), arts)
    assert res.verdict == "not_grounded"            # the model said grounded; the check overrules it
    assert res.model_verdict == "grounded" and res.verdict_mismatch
    assert len(res.quote_errors) == 1 and res.claims[0].final_label == "unsupported"


def test_supported_claim_with_an_empty_quote_is_an_error_too():
    res = evaluate(RawAnswer(payload={"claims": [{"text": "t", "label": "supported"}], "verdict": "grounded"}),
                   [{"topic": "a", "content": "text"}])
    assert res.verdict == "not_grounded" and len(res.quote_errors) == 1


def test_the_verdict_comes_from_the_claims_not_from_the_model():
    answer, arts = fixture("drift")
    answer = {**answer, "verdict": "grounded"}      # the model contradicts its own claims
    res = evaluate(RawAnswer(payload=answer), arts)
    assert res.verdict == "not_grounded" and res.verdict_mismatch


def test_no_claims_at_all_is_grounded():
    res = evaluate(RawAnswer(payload={"claims": [{"text": "Hi", "label": "not_a_claim"}], "verdict": "grounded"}), [])
    assert res.verdict == "grounded"


@pytest.mark.parametrize("payload", [
    {"claims": [{"text": "x", "label": "maybe"}], "verdict": "grounded"},   # label not allowed
    {"claims": [], "verdict": "fine"},                                       # verdict not allowed
    {"verdict": "grounded"},                                                 # claims missing
    "not a dict",
])
def test_invalid_output_is_an_error_with_no_verdict(payload):
    res = evaluate(RawAnswer(payload=payload), [])
    assert res.verdict is None and res.error and "invalid judge output" in res.error


def test_backend_failure_is_an_error_with_no_verdict_and_keeps_the_token_counts():
    res = evaluate(RawAnswer(error="TimeoutError: x", input_tokens=5), [])
    assert res.verdict is None and res.error == "TimeoutError: x" and res.input_tokens == 5


def test_invalid_fixture_file_fails_validation():
    answer, arts = fixture("invalid")
    assert evaluate(RawAnswer(payload=answer), arts).verdict is None


@pytest.mark.parametrize("quote,found", [
    ("Lockout clears automatically after 1 hour.", True),
    ("  lockout   CLEARS\nautomatically after 1 hour.  ", True),                 # whitespace and case
    ("It’s locked", True),                                                  # curly vs straight quote
    ("Lockout clears after 1 hour", False),                                      # a word missing: not forgiven
    ("", False),
    ("   ", False),
])
def test_quote_check_forgives_only_whitespace_case_and_quotes(quote, found):
    arts = [{"topic": "t", "content": "Lockout clears automatically after 1 hour. It's locked."}]
    assert quote_in_articles(quote, arts) is found


def test_a_quote_must_sit_inside_one_article_not_span_two():
    arts = [{"topic": "a", "content": "first part"}, {"topic": "b", "content": "second part"}]
    assert quote_in_articles("second part", arts)
    assert not quote_in_articles("first part second part", arts)


def test_normalise():
    assert normalise("“Hi”  there\n") == '"hi" there'


def test_judge_draft_sends_the_ticket_articles_and_draft_with_the_rules_and_records_the_model():
    answer, arts = fixture("drift")
    backend = FakeBackend(answer)
    res = judge_draft(backend, subject="Locked out", body="help", articles=arts, draft="Hello. Use Forgot password.")
    system, user = backend.seen[0]
    assert "Locked out" in user and "Accounts lock after 5" in user and "Use Forgot password." in user
    assert res.model == "fake-judge" and res.verdict == "not_grounded"


def test_user_message_says_when_there_are_no_articles():
    assert "no articles were given" in build_user_message("s", "b", [], "draft")


def test_the_prompt_carries_the_rules_the_validation_depends_on():
    for rule in ("not_a_claim", "however plausible, helpful, common or true in general", "character for character",
                 "supported: ONLY if an article states it", "verdict: not_grounded if ANY claim is unsupported"):
        assert rule in SYSTEM_PROMPT


def test_schema_has_the_three_labels():
    assert set(JudgeOutput.model_json_schema()["$defs"]["Claim"]["properties"]["label"]["enum"]) == {
        "supported", "unsupported", "not_a_claim"}


def test_judge_model_defaults_to_the_drafting_model_and_can_differ():
    class S:  # noqa: D401
        model_id = "drafter"
        judge_model = ""
    assert resolve_model(S) == "drafter"
    S.judge_model = " other-model "
    assert resolve_model(S) == "other-model"


def test_nothing_in_app_imports_the_judge():
    root = Path(__file__).resolve().parent.parent / "app"
    assert not [p for p in root.rglob("*.py") if ("import evals" in (t := p.read_text(encoding="utf-8")) or "from evals" in t)]
