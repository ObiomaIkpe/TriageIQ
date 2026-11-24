"""evals/scoring.py: every check, the skip cases, and the summary."""
import pytest
from evals.scoring import score_ticket, summarize

LABEL = {
    "expected_category": "account",
    "expected_urgency": "high",
    "expected_flag": False,
    "expected_kb_topic": "account lockout",
    "must_include": ["1 hour"],
    "must_not_include": ["refund"],
}


def make_output(**changes):
    output = {
        "category": "account",
        "urgency": "high",
        "needs_human_review": False,
        "draft_reply": "Your lockout clears after 1 hour.",
        "kb_sources": [{"topic": "account lockout", "distance": 0.33},
                       {"topic": "password reset", "distance": 0.45}],
    }
    output.update(changes)
    return output


def results(label, output):
    return {name: check["result"] for name, check in score_ticket(label, output).items()}


def test_everything_matching_passes():
    assert set(results(LABEL, make_output()).values()) == {"pass"}


def test_check_carries_expected_actual_and_detail():
    check = score_ticket(LABEL, make_output(category="billing"))["category"]
    assert check == {"result": "fail", "expected": "account", "actual": "billing", "detail": ""}


def test_category_mismatch_fails():
    assert results(LABEL, make_output(category="other"))["category"] == "fail"


def test_urgency_mismatch_fails():
    assert results(LABEL, make_output(urgency="low"))["urgency"] == "fail"


def test_null_expected_urgency_is_skipped_whatever_the_output():
    label = {**LABEL, "expected_urgency": None}
    assert results(label, make_output(urgency="critical"))["urgency"] == "skip"


def test_flag_pass_has_neither_missed_nor_extra():
    flag = score_ticket(LABEL, make_output())["flag"]
    assert flag["result"] == "pass"
    assert flag["missed_flag"] is False and flag["extra_flag"] is False


def test_missed_flag():
    label = {**LABEL, "expected_flag": True}
    flag = score_ticket(label, make_output(needs_human_review=False))["flag"]
    assert flag["result"] == "fail"
    assert flag["missed_flag"] is True and flag["extra_flag"] is False


def test_extra_flag():
    flag = score_ticket(LABEL, make_output(needs_human_review=True))["flag"]
    assert flag["result"] == "fail"
    assert flag["extra_flag"] is True and flag["missed_flag"] is False


def test_correctly_flagged_is_a_pass():
    label = {**LABEL, "expected_flag": True}
    flag = score_ticket(label, make_output(needs_human_review=True))["flag"]
    assert flag["result"] == "pass"
    assert flag["missed_flag"] is False and flag["extra_flag"] is False


def test_kb_topic_uses_the_first_source():
    check = score_ticket(LABEL, make_output())["kb_topic"]
    assert check["actual"] == "account lockout"
    wrong_first = make_output(kb_sources=[{"topic": "password reset", "distance": 0.3},
                                          {"topic": "account lockout", "distance": 0.4}])
    assert results(LABEL, wrong_first)["kb_topic"] == "fail"


def test_no_sources_and_no_expected_topic_passes():
    label = {**LABEL, "expected_kb_topic": None, "must_include": []}
    check = score_ticket(label, make_output(kb_sources=[]))["kb_topic"]
    assert check["result"] == "pass" and check["actual"] is None


def test_no_sources_but_a_topic_expected_fails():
    assert results(LABEL, make_output(kb_sources=[]))["kb_topic"] == "fail"


def test_source_found_but_none_expected_fails():
    label = {**LABEL, "expected_kb_topic": None}
    assert results(label, make_output())["kb_topic"] == "fail"


def test_must_include_is_case_insensitive():
    label = {**LABEL, "must_include": ["LOCKOUT CLEARS"]}
    assert results(label, make_output())["must_include"] == "pass"


def test_must_include_lists_the_missing_phrases():
    label = {**LABEL, "must_include": ["1 hour", "5 failed", "support"]}
    check = score_ticket(label, make_output())["must_include"]
    assert check["result"] == "fail"
    assert check["detail"] == "missing: 5 failed, support"


def test_must_not_include_passes_when_absent():
    assert results(LABEL, make_output())["must_not_include"] == "pass"


def test_must_not_include_is_case_insensitive_and_lists_found_phrases():
    label = {**LABEL, "must_not_include": ["REFUND", "1 hour", "nothing"]}
    check = score_ticket(label, make_output(draft_reply="Lockout lasts 1 Hour. No refund."))[
        "must_not_include"]
    assert check["result"] == "fail"
    assert check["detail"] == "found: REFUND, 1 hour"


def test_phrase_checks_skip_without_a_draft():
    for draft in (None, "", "   "):
        r = results(LABEL, make_output(draft_reply=draft))
        assert r["must_include"] == "skip" and r["must_not_include"] == "skip"


def test_draft_missing_key_is_treated_as_no_draft():
    output = make_output()
    del output["draft_reply"]
    r = results(LABEL, output)
    assert r["must_include"] == "skip" and r["must_not_include"] == "skip"


def test_phrase_checks_skip_with_an_empty_list():
    label = {**LABEL, "must_include": [], "must_not_include": []}
    r = results(label, make_output())
    assert r["must_include"] == "skip" and r["must_not_include"] == "skip"


def test_summarize_counts_and_flag_lists():
    cases = [
        ("T01", LABEL, make_output()),
        ("T02", {**LABEL, "expected_flag": True, "expected_urgency": None},
         make_output(category="billing")),
        ("T03", LABEL, make_output(needs_human_review=True, draft_reply=None)),
    ]
    scored = [{"id": i, "scores": score_ticket(l, o)} for i, l, o in cases]
    summary = summarize(scored)

    assert summary["checks"]["category"] == {"pass": 2, "fail": 1, "skip": 0}
    assert summary["checks"]["urgency"] == {"pass": 2, "fail": 0, "skip": 1}
    assert summary["checks"]["flag"] == {"pass": 1, "fail": 2, "skip": 0}
    assert summary["checks"]["kb_topic"] == {"pass": 3, "fail": 0, "skip": 0}
    assert summary["checks"]["must_include"] == {"pass": 2, "fail": 0, "skip": 1}
    assert summary["checks"]["must_not_include"] == {"pass": 2, "fail": 0, "skip": 1}
    assert summary["missed_flags"] == ["T02"]
    assert summary["extra_flags"] == ["T03"]


def test_summarize_of_nothing_is_all_zero():
    summary = summarize([])
    assert summary["missed_flags"] == [] and summary["extra_flags"] == []
    assert all(c == {"pass": 0, "fail": 0, "skip": 0} for c in summary["checks"].values())


# --- deterministic reply checks (Part B of M5a) ---------------------------------------------------
from evals.scoring import draft_without_kb, has_markdown, has_subject_line, reply_checks, summarize_reply_checks  # noqa: E402


@pytest.mark.parametrize("text,expected", [
    ("Click **Forgot password** to continue.", True),
    ("Click __Forgot password__.", True),
    ("# Steps\nDo this.", True),
    ("Use the `reset` link.", True),
    ("Here:\n- first\n- second", True),
    ("Here:\n* first", True),
    ("See [our guide](https://example.com/x).", True),
    ("Click 'Forgot password' on the sign-in page.", False),
    ("Steps:\n1. Open the page.\n2. Click the link.", False),
    ("A 5 * 3 sum, and a #hashtag mid-line, and snake_case_name.", False),
    ("Your lockout clears after 1 hour - no action needed.", False),
    ("", False),
    (None, False),
])
def test_has_markdown(text, expected):
    assert has_markdown(text) is expected


@pytest.mark.parametrize("text,expected", [
    ("Subject: Re: your ticket\n\nHi", True),
    ("  \n subject: Re", True),
    ("Hi,\nSubject: not first", False),
    ("The subject: of your ticket", False),
    (None, False),
])
def test_has_subject_line(text, expected):
    assert has_subject_line(text) is expected


@pytest.mark.parametrize("draft,sources,expected", [
    ("A reply.", [], True),
    ("A reply.", None, True),
    ("A reply.", [{"topic": "x"}], False),
    ("   ", [], False),
    (None, [], False),
])
def test_draft_without_kb(draft, sources, expected):
    assert draft_without_kb(draft, sources) is expected


def test_reply_checks_and_rates():
    ok = {"draft_reply": "Fine.", "kb_sources": [{"topic": "a"}]}
    bad = {"draft_reply": "Subject: x\n**hi**", "kb_sources": []}
    none = {"draft_reply": None, "kb_sources": []}
    assert reply_checks(bad) == {"has_markdown": True, "has_subject_line": True, "draft_without_kb": True}
    assert reply_checks(none) == {"has_markdown": False, "has_subject_line": False, "draft_without_kb": False}
    s = summarize_reply_checks([{"id": "A", "output": ok}, {"id": "B", "output": bad},
                                {"id": "C", "output": none}, {"id": "D", "output": None}])
    assert s["has_markdown"] == {"hits": ["B"], "count": 1, "of": 2, "rate": 0.5}      # out of tickets with a draft
    assert s["draft_without_kb"]["of"] == 3 and s["draft_without_kb"]["hits"] == ["B"]  # out of all with an output
