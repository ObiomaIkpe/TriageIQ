"""evals/run_eval.py on a 3-ticket dataset. Claude and the KB search are faked; the
graph (with a MemorySaver) and the scoring run for real."""
import json

import pytest

from app.graph import classifier, critic, kb_retrieval, reply_draft
from app.graph.critic import CritiqueResult
from app.models import Category, ClassificationResult, KbMatch, Urgency
from app.tickets import store as tickets_store
from evals import run_eval
from tests.helpers import ai_message

KB_MATCH = KbMatch(topic="account lockout", content="Lockout clears after 1 hour.", distance=0.33)


def label(ticket_id, subject, **changes):
    base = {
        "id": ticket_id, "subject": subject, "body": "body of " + subject,
        "expected_category": "account", "expected_urgency": "high", "expected_flag": False,
        "expected_kb_topic": "account lockout", "must_include": ["1 hour"],
        "must_not_include": [], "notes": "", "label_source": "human_verified",
    }
    base.update(changes)
    return base


LABELS = [
    label("E1", "locked out"),
    label("E2", "vague", expected_flag=True, expected_kb_topic=None, must_include=[]),
    label("E3", "boom"),
]


class FakeClassifier:
    """Confident for E1, unsure for E2, and a crash for E3."""

    def __init__(self):
        self.subjects = []

    def invoke(self, inputs):
        self.subjects.append(inputs["subject"])
        if inputs["subject"] == "boom":
            raise RuntimeError("model unavailable")
        confidence = 0.2 if inputs["subject"] == "vague" else 0.95
        return ClassificationResult(
            category=Category.account, urgency=Urgency.high,
            confidence=confidence, reasoning="r",
        )


class FakeChain:
    def __init__(self, result):
        self.result = result

    def invoke(self, inputs):
        return self.result


@pytest.fixture
def fakes(monkeypatch):
    f = type("Fakes", (), {})()
    f.classify = FakeClassifier()
    f.saves = []

    monkeypatch.setattr(classifier, "_chain", f.classify)
    monkeypatch.setattr(reply_draft, "_chain",
                        FakeChain(ai_message("Your lockout clears after 1 hour.")))
    monkeypatch.setattr(critic, "_chain",
                        FakeChain(CritiqueResult(needs_human_review=False, reason="")))
    monkeypatch.setattr(kb_retrieval, "search_similar", lambda q, top_k: [KB_MATCH])

    def record_save(*args, **kwargs):
        f.saves.append(args)
        raise AssertionError("the eval must never save a ticket")

    # Both names: the store itself, and the copy the triage route imported.
    monkeypatch.setattr(tickets_store, "save_ticket", record_save)
    from app.api import triage
    monkeypatch.setattr(triage, "save_ticket", record_save)
    return f


@pytest.fixture
def dataset(tmp_path):
    path = tmp_path / "tickets.jsonl"
    path.write_text("\n".join(json.dumps(l) for l in LABELS) + "\n", encoding="utf-8")
    return path


def run(dataset, out, *extra):
    return run_eval.main(["--dataset", str(dataset), "--out", str(out), *extra])


def read_result(out):
    files = sorted(out.glob("*.json"))
    assert len(files) == 1
    return json.loads(files[0].read_text(encoding="utf-8"))


def test_writes_json_and_md_with_the_same_timestamp_name(fakes, dataset, tmp_path):
    out = tmp_path / "results"
    assert run(dataset, out) == 0

    (json_file,), (md_file,) = list(out.glob("*.json")), list(out.glob("*.md"))
    assert json_file.stem == md_file.stem
    assert len(json_file.stem) == len("20261020-101500")

    result = json.loads(json_file.read_text(encoding="utf-8"))
    assert result["dataset"] == str(dataset)
    assert result["model"]
    assert result["git_commit"]
    assert result["started_at"] and result["duration_seconds"] >= 0
    assert [t["id"] for t in result["tickets"]] == ["E1", "E2", "E3"]
    assert {"label", "output", "scores", "latency_seconds", "error"} <= set(result["tickets"][0])
    assert "# Eval scorecard" in md_file.read_text(encoding="utf-8")


def test_prints_the_scorecard(fakes, dataset, tmp_path, capsys):
    run(dataset, tmp_path / "r")
    printed = capsys.readouterr().out
    assert "MISSED FLAGS" in printed and "ERRORS" in printed and "median" in printed


def test_a_normal_ticket_is_scored_from_the_final_state(fakes, dataset, tmp_path):
    run(dataset, tmp_path / "r")
    e1 = read_result(tmp_path / "r")["tickets"][0]

    assert e1["error"] is None
    assert e1["output"]["paused"] is False
    assert e1["output"]["draft_reply"] == "Your lockout clears after 1 hour."
    assert e1["output"]["kb_sources"][0]["topic"] == "account lockout"
    assert {c["result"] for c in e1["scores"].values()} == {"pass", "skip"}
    assert e1["scores"]["must_include"]["result"] == "pass"


def test_a_paused_ticket_is_scored_from_its_paused_state(fakes, dataset, tmp_path):
    run(dataset, tmp_path / "r")
    e2 = read_result(tmp_path / "r")["tickets"][1]

    assert e2["error"] is None
    assert e2["output"]["paused"] is True
    assert e2["output"]["needs_human_review"] is True
    assert e2["output"]["draft_reply"] is None
    assert e2["output"]["kb_sources"] == []
    assert e2["scores"]["flag"]["result"] == "pass"
    assert e2["scores"]["must_include"]["result"] == "skip"
    assert e2["scores"]["kb_topic"]["result"] == "pass"  # None == None


def test_a_ticket_that_raises_is_an_error_and_the_run_continues(fakes, dataset, tmp_path):
    out = tmp_path / "r"
    assert run(dataset, out, "--only", "E3,E1") == 0

    tickets = read_result(out)["tickets"]
    assert [t["id"] for t in tickets] == ["E1", "E3"]  # dataset order, not --only order
    assert tickets[1]["error"] == "RuntimeError: model unavailable"
    assert tickets[1]["output"] is None and tickets[1]["scores"] is None
    assert tickets[0]["error"] is None

    md = next(out.glob("*.md")).read_text(encoding="utf-8")
    assert "E3: RuntimeError: model unavailable" in md


def test_error_in_the_middle_does_not_stop_later_tickets(fakes, tmp_path):
    labels = [LABELS[0], LABELS[2], label("E4", "locked out again")]
    path = tmp_path / "t.jsonl"
    path.write_text("\n".join(json.dumps(l) for l in labels), encoding="utf-8")
    run(path, tmp_path / "r")

    tickets = read_result(tmp_path / "r")["tickets"]
    assert [t["id"] for t in tickets] == ["E1", "E3", "E4"]
    assert tickets[1]["error"] and tickets[2]["error"] is None


def test_only_runs_just_those_tickets_one_at_a_time_in_order(fakes, dataset, tmp_path):
    run(dataset, tmp_path / "r", "--only", "E1")
    assert [t["id"] for t in read_result(tmp_path / "r")["tickets"]] == ["E1"]
    assert fakes.classify.subjects == ["locked out"]


def test_all_tickets_run_in_dataset_order(fakes, dataset, tmp_path):
    run(dataset, tmp_path / "r")
    assert fakes.classify.subjects == ["locked out", "vague", "boom"]


def test_unknown_id_in_only_exits_with_a_message(fakes, dataset, tmp_path, capsys):
    assert run(dataset, tmp_path / "r", "--only", "E1,T99") == 1
    assert "T99" in capsys.readouterr().err
    assert not (tmp_path / "r").exists()
    assert fakes.classify.subjects == []


def test_no_ticket_is_ever_saved(fakes, dataset, tmp_path):
    run(dataset, tmp_path / "r")
    assert fakes.saves == []


@pytest.mark.parametrize("name", ["anthropic_api_key", "voyage_api_key"])
def test_missing_key_exits_before_any_ticket_runs(fakes, dataset, tmp_path, monkeypatch, capsys, name):
    from app.config import settings
    monkeypatch.setattr(settings, name, "")

    assert run(dataset, tmp_path / "r") == 1
    err = capsys.readouterr().err
    assert name.upper() in err
    assert fakes.classify.subjects == []
    assert not (tmp_path / "r").exists()


def test_the_key_message_never_contains_a_key_value(fakes, dataset, tmp_path, monkeypatch, capsys):
    from app.config import settings
    monkeypatch.setattr(settings, "anthropic_api_key", "")
    monkeypatch.setattr(settings, "voyage_api_key", "super-secret-value")
    run(dataset, tmp_path / "r")
    captured = capsys.readouterr()
    assert "super-secret-value" not in captured.out + captured.err


def test_markdown_sections_come_in_the_required_order(fakes, tmp_path):
    labels = [
        label("E1", "locked out", expected_flag=True, expected_category="billing",
              must_include=["nonexistent phrase"], must_not_include=["clears"]),
    ]
    path = tmp_path / "t.jsonl"
    path.write_text(json.dumps(labels[0]) + "\n", encoding="utf-8")
    run(path, tmp_path / "r")
    md = next((tmp_path / "r").glob("*.md")).read_text(encoding="utf-8")

    titles = ["## Scores", "## MISSED FLAGS", "## EXTRA FLAGS", "## REPLY FAILURES",
              "## OTHER FAILURES", "## ERRORS", "## Latency"]
    positions = [md.index(title) for title in titles]
    assert positions == sorted(positions)

    missed = md.split("## MISSED FLAGS")[1].split("## EXTRA FLAGS")[0]
    assert "- E1" in missed
    assert "missing: nonexistent phrase" in md
    assert "found: clears" in md
    assert "expected 'billing', actual 'account'" in md


def test_md_notes_skips_in_the_counts(fakes, dataset, tmp_path):
    run(dataset, tmp_path / "r", "--only", "E1,E2")
    md = next((tmp_path / "r").glob("*.md")).read_text(encoding="utf-8")
    assert "- category: 2/2" in md
    assert "- must_include: 1/1 (1 skipped)" in md
