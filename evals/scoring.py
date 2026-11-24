"""Deterministic scoring of one triage output against its label.

Pure functions: no I/O, no LLM calls, nothing random. The same label and output
always give the same scores.

A label is one line of the dataset (expected_category, expected_urgency, ...). An
output is the dict the runner builds from the graph state:
    category, urgency            plain strings ("billing", "high")
    needs_human_review           bool
    draft_reply                  str, or None when the ticket skipped drafting
    kb_sources                   list of {"topic": str, "distance": float}, closest first
"""

import re

CHECKS = ("category", "urgency", "flag", "kb_topic", "must_include", "must_not_include")


def _check(result: str, expected, actual, detail: str = "") -> dict:
    return {"result": result, "expected": expected, "actual": actual, "detail": detail}


def _has_text(draft) -> bool:
    return bool(draft and draft.strip())


def _first_kb_topic(output: dict):
    sources = output.get("kb_sources") or []
    return sources[0]["topic"] if sources else None


def _phrases_in(draft: str, phrases: list) -> tuple[list, list]:
    """(found, missing) phrases, matched case-insensitively."""
    lowered = draft.lower()
    found = [p for p in phrases if p.lower() in lowered]
    missing = [p for p in phrases if p.lower() not in lowered]
    return found, missing


def score_ticket(label: dict, output: dict) -> dict:
    scores = {}

    expected = label["expected_category"]
    actual = output["category"]
    scores["category"] = _check("pass" if actual == expected else "fail", expected, actual)

    expected = label.get("expected_urgency")
    actual = output["urgency"]
    if expected is None:
        scores["urgency"] = _check("skip", None, actual, "no expected urgency")
    else:
        scores["urgency"] = _check("pass" if actual == expected else "fail", expected, actual)

    expected = bool(label["expected_flag"])
    actual = bool(output["needs_human_review"])
    flag = _check("pass" if actual == expected else "fail", expected, actual)
    flag["missed_flag"] = expected and not actual
    flag["extra_flag"] = actual and not expected
    scores["flag"] = flag

    expected = label.get("expected_kb_topic")
    actual = _first_kb_topic(output)
    scores["kb_topic"] = _check("pass" if actual == expected else "fail", expected, actual)

    draft = output.get("draft_reply")
    for name, wants_found in (("must_include", True), ("must_not_include", False)):
        phrases = label.get(name) or []
        if not _has_text(draft):
            scores[name] = _check("skip", phrases, None, "no draft")
        elif not phrases:
            scores[name] = _check("skip", phrases, draft, "no phrases to check")
        else:
            found, missing = _phrases_in(draft, phrases)
            if wants_found:
                ok, detail = not missing, ("missing: " + ", ".join(missing) if missing else "")
            else:
                ok, detail = not found, ("found: " + ", ".join(found) if found else "")
            scores[name] = _check("pass" if ok else "fail", phrases, draft, detail)

    return scores


def summarize(scored: list) -> dict:
    """Totals over scored tickets, each item {"id": str, "scores": score_ticket(...)}."""
    checks = {name: {"pass": 0, "fail": 0, "skip": 0} for name in CHECKS}
    missed, extra = [], []
    for item in scored:
        for name in CHECKS:
            checks[name][item["scores"][name]["result"]] += 1
        flag = item["scores"]["flag"]
        if flag["missed_flag"]:
            missed.append(item["id"])
        if flag["extra_flag"]:
            extra.append(item["id"])
    return {"checks": checks, "missed_flags": missed, "extra_flags": extra}


# --- Deterministic reply checks (plain code, no AI) ------------------------------------------------
# Three known drafter problems seen in production. They are reported next to the scores, per ticket and
# as rates, and are NOT part of CHECKS (a draft can pass every label check and still have these).
REPLY_CHECKS = ("has_markdown", "has_subject_line", "draft_without_kb")

_MARKDOWN_PATTERNS = (
    re.compile(r"\*\*[^*\n]+\*\*"),                     # **bold**
    re.compile(r"__[^_\s][^_\n]*__"),                      # __bold__
    re.compile(r"^[ \t]{0,3}#{1,6}[ \t]+\S", re.MULTILINE),  # # heading
    re.compile(r"`"),                                      # `code`
    re.compile(r"^[ \t]*[-*+][ \t]+\S", re.MULTILINE),     # - bullet, * bullet, + bullet
    re.compile(r"\[[^\]\n]+\]\([^)\s]+\)"),               # [text](url)
)
_SUBJECT_LINE = re.compile(r"\A\s*subject\s*:", re.IGNORECASE)


def has_markdown(draft) -> bool:
    """True if the reply uses Markdown (bold, headings, backticks, bullets or links). A reply is
    sent as plain text, where these show as raw characters."""
    return _has_text(draft) and any(p.search(draft) for p in _MARKDOWN_PATTERNS)


def has_subject_line(draft) -> bool:
    """True if the reply starts (after optional whitespace) with "Subject:"."""
    return _has_text(draft) and bool(_SUBJECT_LINE.match(draft))


def draft_without_kb(draft, kb_sources) -> bool:
    """True if a non-empty draft was written although no KB article was given to the drafter."""
    return _has_text(draft) and not kb_sources


def reply_checks(output: dict) -> dict:
    """The three checks for one output: {name: True | False}. All False when there is no draft."""
    draft = output.get("draft_reply")
    return {
        "has_markdown": has_markdown(draft),
        "has_subject_line": has_subject_line(draft),
        "draft_without_kb": draft_without_kb(draft, output.get("kb_sources")),
    }


def summarize_reply_checks(items: list) -> dict:
    """Per check: how many tickets hit it, out of how many, and which. Items are
    {"id": str, "output": dict-or-None}. Tickets that errored have no output and are left out.
    has_markdown and has_subject_line are out of the tickets that HAVE a draft; draft_without_kb is
    out of every ticket (a ticket with no draft cannot hit it, but it is part of the set)."""
    with_output = [i for i in items if i.get("output")]
    drafted = [i for i in with_output if _has_text(i["output"].get("draft_reply"))]
    summary = {}
    for name in REPLY_CHECKS:
        pool = with_output if name == "draft_without_kb" else drafted
        hits = [i["id"] for i in pool if reply_checks(i["output"])[name]]
        summary[name] = {"hits": hits, "count": len(hits), "of": len(pool),
                         "rate": (len(hits) / len(pool)) if pool else None}
    return summary
