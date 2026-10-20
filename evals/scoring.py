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
