"""Freeze, split, label and validate (evals/judge/*) end to end with fakes: no API calls, no database."""
import json
from types import SimpleNamespace

import pytest

from app.models import Category, ClassificationResult, KbMatch, Urgency
from evals.judge import common, freeze_drafts, label, split, validate
from evals.judge.judge import RawAnswer

KB = KbMatch(topic="account lockout", content="Lockout clears automatically after 1 hour.", distance=0.3)
SETTINGS = SimpleNamespace(anthropic_api_key="a", voyage_api_key="v", model_id="drafter-model", voyage_rpm=3)


def state(draft, kb=(KB,), flag=False):
    return {"classification": ClassificationResult(category=Category.account, urgency=Urgency.high,
                                                   confidence=0.9, reasoning="r"),
            "kb_context": list(kb), "draft_reply": draft, "needs_human_review": flag,
            "review_reason": "SECRET-CRITIC-REASON" if flag else ""}


class FakeGraph:
    def __init__(self, states):
        self.states, self.calls = states, 0

    def invoke(self, inputs, config=None):
        self.calls += 1
        s = self.states[inputs["ticket"].subject]
        if isinstance(s, Exception):
            raise s
        return s


def dataset(tmp_path, ids):
    p = tmp_path / "tickets_v2.jsonl"
    p.write_text("".join(json.dumps({"id": i, "subject": f"s-{i}", "body": f"b-{i}"}) + "\n" for i in ids))
    return p


def make_frozen(tmp_path, spec):
    """spec: {id: (draft or None, flagged)} -> a frozen file written the way freeze writes it."""
    rows = []
    for i, (draft, flag) in spec.items():
        rows.append({"id": i, "subject": f"s-{i}", "body": f"b-{i}", "kb_articles": [] if draft is None else
                     [{"topic": "account lockout", "content": "Lockout clears automatically after 1 hour.", "distance": 0.3}],
                     "draft": draft, "judged": bool(draft), "category": "account", "needs_human_review": flag,
                     "review_reason": "SECRET-CRITIC-REASON" if flag else None, "error": None,
                     "git_commit": "abc123", "models": {"drafter": "drafter-model"}, "dataset": "d", "frozen_at": "t"})
    path = tmp_path / "frozen" / "drafts_2026-11-24.jsonl"
    common.write_jsonl(path, rows)
    return path


# --- freeze ----------------------------------------------------------------------------------------
def test_latest_dataset_picks_the_highest_version_number(tmp_path):
    for n in ("tickets_v2.jsonl", "tickets_v10.jsonl", "tickets_v9.jsonl", "notes.jsonl"):
        (tmp_path / n).write_text("")
    assert freeze_drafts.latest_dataset(tmp_path).name == "tickets_v10.jsonl"


def test_freeze_one_keeps_the_articles_the_drafter_received_in_full_and_survives_errors():
    graph = FakeGraph({"s-A": state("Hello."), "s-B": state(None, kb=()), "s-C": RuntimeError("boom")})
    meta = {"git_commit": "abc"}
    a = freeze_drafts.freeze_one(graph, {"id": "A", "subject": "s-A", "body": "b"}, meta)
    b = freeze_drafts.freeze_one(graph, {"id": "B", "subject": "s-B", "body": "b"}, meta)
    c = freeze_drafts.freeze_one(graph, {"id": "C", "subject": "s-C", "body": "b"}, meta)
    assert a["kb_articles"] == [{"topic": "account lockout", "content": KB.content, "distance": 0.3}]
    assert a["judged"] and a["git_commit"] == "abc"
    assert b["draft"] is None and not b["judged"] and b["error"] is None     # no draft: kept, not judged
    assert c["error"] == "RuntimeError: boom" and not c["judged"]


def run_freeze(tmp_path, answers, graph, extra=()):
    ds = dataset(tmp_path, ["A", "B", "C", "D"])
    out = tmp_path / "frozen" / "drafts_x.jsonl"
    asked = []

    def ask(prompt):
        asked.append(prompt)
        return answers

    code = freeze_drafts.main(["--dataset", str(ds), "--out", str(out), *extra], input_fn=ask, graph=graph, settings=SETTINGS)
    return code, out, asked


def graph4():
    return FakeGraph({"s-A": state("Reply A."), "s-B": state("Reply B.", flag=True),
                      "s-C": state("Reply C."), "s-D": state(None, kb=())})


def test_freeze_asks_before_spending_and_nothing_happens_on_no(tmp_path, capsys):
    g = graph4()
    code, out, asked = run_freeze(tmp_path, "n", g)
    assert code == 1 and g.calls == 0 and not out.exists()
    assert "[y/N]" in asked[0] and "Estimated cost" in capsys.readouterr().out
    code, out, _ = run_freeze(tmp_path, "", g)       # a bare Enter is no
    assert code == 1 and g.calls == 0


def test_freeze_on_yes_writes_the_drafts_and_the_split_and_keeps_tickets_without_a_draft(tmp_path):
    g = graph4()
    code, out, _ = run_freeze(tmp_path, "y", g)
    assert code == 0 and g.calls == 4
    rows = common.load_frozen(out)
    assert [r["id"] for r in rows] == ["A", "B", "C", "D"]
    assert [r["judged"] for r in rows] == [True, True, True, False]
    sp = json.loads(common.split_path(out).read_text())
    assert sorted(sp["tune"] + sp["test"]) == ["A", "B", "C"]               # D is not judged
    assert set(sp["tune"]).isdisjoint(sp["test"]) and sp["tune"] and sp["test"]


def test_freeze_never_overwrites_and_needs_the_keys(tmp_path):
    g = graph4()
    run_freeze(tmp_path, "y", g)
    code, _, asked = run_freeze(tmp_path, "y", g)
    assert code == 1 and asked == []
    ds = dataset(tmp_path, ["A"])
    assert freeze_drafts.main(["--dataset", str(ds), "--out", str(tmp_path / "o.jsonl")], input_fn=lambda p: "y", graph=g,
                              settings=SimpleNamespace(anthropic_api_key="", voyage_api_key="v", model_id="m", voyage_rpm=3)) == 1


# --- split -----------------------------------------------------------------------------------------
STRATA = {f"T{i:02d}": ("suspect" if i % 3 == 0 else "clean") for i in range(1, 16)}


def test_split_is_deterministic_and_independent_of_input_order():
    a = split.make_split(STRATA)
    b = split.make_split(dict(reversed(list(STRATA.items()))))
    assert a == b and a == split.make_split(STRATA)


def test_split_covers_every_ticket_once_is_about_60_40_and_keeps_each_stratum_on_both_sides():
    s = split.make_split(STRATA)
    assert sorted(s["tune"] + s["test"]) == sorted(STRATA)
    assert set(s["tune"]).isdisjoint(s["test"])
    assert len(s["tune"]) == 9 and len(s["test"]) == 6
    for stratum in ("suspect", "clean"):
        assert any(STRATA[i] == stratum for i in s["tune"]) and any(STRATA[i] == stratum for i in s["test"])


def test_split_changes_with_the_seed_and_handles_tiny_strata():
    assert split.make_split(STRATA, seed=1) != split.make_split(STRATA, seed=2)
    assert split.make_split({"A": "x"}) == {"tune": ["A"], "test": []}
    two = split.make_split({"A": "x", "B": "x"})
    assert len(two["tune"]) == 1 and len(two["test"]) == 1


def test_split_by_labels_refuses_until_labelled_then_stratifies_by_my_labels(tmp_path, monkeypatch, capsys):
    frozen = make_frozen(tmp_path, {f"T{i}": (f"Reply {i}.", False) for i in range(1, 7)})
    monkeypatch.setattr(split, "labels_path", lambda f: common.labels_path(f, tmp_path / "labels"))
    assert split.main([str(frozen), "--by-labels"]) == 1 and "not labelled yet" in capsys.readouterr().err
    common.write_jsonl(common.labels_path(frozen, tmp_path / "labels"),
                       [{"id": f"T{i}", "grounded": i > 2, "unsupported_sentences": [], "note": ""} for i in range(1, 7)])
    assert split.main([str(frozen), "--by-labels"]) == 0
    sp = json.loads(common.split_path(frozen).read_text())
    assert sp["basis"] == "labels"
    not_grounded = {"T1", "T2"}
    assert not_grounded & set(sp["tune"]) and not_grounded & set(sp["test"])


def test_sentences_are_split_the_same_way_every_time():
    text = "Hi Sam,\n\nYour lockout clears after 1 hour. Please wait! Is that clear?\nThanks."
    assert common.split_sentences(text) == ["Hi Sam,", "Your lockout clears after 1 hour.", "Please wait!",
                                            "Is that clear?", "Thanks."]
    assert common.split_sentences("") == [] and common.split_sentences(None) == []


# --- label -----------------------------------------------------------------------------------------
def scripted(answers):
    it = iter(answers)

    def ask(prompt):
        try:
            return next(it)
        except StopIteration:
            raise EOFError

    return ask


def run_label(frozen, tmp_path, answers):
    shown = []
    code = label.run(frozen, labels_dir=tmp_path / "labels", input_fn=scripted(answers), out=shown.append)
    return code, "\n".join(shown), common.load_labels(common.labels_path(frozen, tmp_path / "labels"))


def test_label_saves_after_every_answer_and_records_sentences_and_note(tmp_path):
    frozen = make_frozen(tmp_path, {"A": ("Hi. Lockout clears after 1 hour.", False),
                                    "B": ("Hi. Use Forgot password. Wait 2 hours.", True)})
    # answer A, then B as "n" with sentence numbers and a note, then the input ends (quit by EOF)
    code, shown, labels = run_label(frozen, tmp_path, ["y", "n", "2, 3", "invented advice"])
    assert code == 0
    assert labels["A"]["grounded"] is True and labels["A"]["unsupported_sentences"] == []
    assert labels["B"] == {**labels["B"], "grounded": False, "unsupported_sentences": [2, 3], "note": "invented advice"}
    assert "[1] Hi." in shown and "[3] Wait 2 hours." in shown


def test_label_resumes_where_it_stopped(tmp_path):
    frozen = make_frozen(tmp_path, {"A": ("One.", False), "B": ("Two.", False), "C": ("Three.", False)})
    run_label(frozen, tmp_path, ["y", "q"])                      # answers A, quits at B
    code, shown, labels = run_label(frozen, tmp_path, ["y", "y"])
    assert "Resuming: 1 of 3" in shown and "(ticket B)" in shown.split("Resuming")[1]
    assert set(labels) == {"A", "B", "C"}


def test_label_back_goes_to_the_previous_draft_and_the_new_answer_replaces_the_old(tmp_path):
    frozen = make_frozen(tmp_path, {"A": ("One.", False), "B": ("Two.", False)})
    code, shown, labels = run_label(frozen, tmp_path, ["y", "b", "n", "1", "was wrong", "y"])
    assert labels["A"]["grounded"] is False and labels["A"]["note"] == "was wrong"
    assert labels["B"]["grounded"] is True
    assert "your earlier answer: grounded" in shown                   # the old answer is shown when going back


def test_label_rejects_bad_input_and_back_at_the_start_stays_put(tmp_path):
    frozen = make_frozen(tmp_path, {"A": ("One. Two.", False)})
    code, shown, labels = run_label(frozen, tmp_path, ["b", "maybe", "n", "9", "x", "2", ""])
    assert "Please type y, n, b or q." in shown and "Use numbers from 1 to 2" in shown
    assert labels["A"]["unsupported_sentences"] == [2]


def test_label_is_blind_wraps_to_80_columns_and_skips_tickets_without_a_draft(tmp_path):
    long = "Word " * 60
    frozen = make_frozen(tmp_path, {"A": (long.strip() + ".", True), "B": (None, False)})
    code, shown, labels = run_label(frozen, tmp_path, ["y"])
    assert "SECRET-CRITIC-REASON" not in shown and "needs_human_review" not in shown and "critic" not in shown.lower()
    assert max(len(l) for l in shown.splitlines() if str(tmp_path) not in l) <= 80
    assert set(labels) == {"A"} and "Draft 1 of 1" in shown          # B has no draft: never shown


# --- validate --------------------------------------------------------------------------------------
class ScriptedJudge:
    """Judges by reading the draft: 'INVENTED' in it -> an unsupported claim; per-run flips via `flip`."""
    model = "fake-judge"

    def __init__(self, flip=()):
        self.flip, self.calls = set(flip), 0

    def complete(self, system, user):
        self.calls += 1
        draft = user.split("DRAFT REPLY START\n")[1]
        bad = "INVENTED" in draft
        if (self.calls, ) and any(f in draft for f in self.flip) and self.calls > 6:
            bad = not bad
        claims = [{"text": "c", "label": "unsupported" if bad else "supported",
                   "evidence_quote": "" if bad else "Lockout clears automatically after 1 hour."}]
        return RawAnswer(payload={"claims": claims, "verdict": "not_grounded" if bad else "grounded"},
                         input_tokens=1000, output_tokens=100, model="fake-judge")


def prepared(tmp_path, labels_for):
    spec = {"G1": ("Lockout clears after 1 hour.", False), "G2": ("Ok it clears.", False),
            "N1": ("INVENTED advice one.", False), "N2": ("INVENTED sneaky advice.", False)}
    frozen = make_frozen(tmp_path, spec)
    split.save_split(frozen, {"tune": ["G1", "N1", "N2"], "test": ["G2"]}, basis="test")
    ldir = tmp_path / "labels"
    common.write_jsonl(common.labels_path(frozen, ldir), [
        {"id": i, "grounded": g, "unsupported_sentences": [] if g else [1], "note": "" if g else f"my note on {i}"}
        for i, g in labels_for.items()])
    return frozen, ldir


def test_validate_refuses_when_a_label_is_missing_and_never_calls_the_judge(tmp_path):
    frozen, ldir = prepared(tmp_path, {"G1": True, "N1": False})                      # N2 unlabelled
    judge = ScriptedJudge()
    with pytest.raises(validate.Refused, match="N2"):
        validate.validate(frozen, "tune", 3, judge, labels_dir=ldir, out_dir=tmp_path / "r")
    assert judge.calls == 0
    assert validate.main(["--split", "tune", "--frozen", str(tmp_path / "nope.jsonl")], backend=judge) == 1


def test_validate_end_to_end_reports_false_pass_first_with_every_disagreement(tmp_path):
    # I say N2 is NOT grounded, G1 grounded, N1 GROUNDED (so the judge's "not grounded" is a false fail)
    frozen, ldir = prepared(tmp_path, {"G1": True, "N1": True, "N2": False})
    judge = ScriptedJudge()
    md, js, m = validate.validate(frozen, "tune", 3, judge, labels_dir=ldir, out_dir=tmp_path / "r")
    assert judge.calls == 9 and m["valid"] == 9
    assert m["matrix"] == {"grounded": {"grounded": 3, "not_grounded": 3}, "not_grounded": {"grounded": 0, "not_grounded": 3}}
    assert m["agree"] == 6 and m["agreement"] == pytest.approx(6 / 9)
    assert m["false_pass_rate"] == 0 and m["false_fail_rate"] == pytest.approx(0.5)
    assert m["consistent"] == 3 and m["quote_errors"] == 0
    assert m["cost_usd"] is None                                    # "fake-judge" has no price: unknown, not zero
    text = md.read_text()
    assert text.index("FALSE PASS") < text.index("## Agreement")
    assert "Judge model: `fake-judge`" in text and "commit `abc123`" in text
    assert text.count("### FALSE FAIL: N1") == 3 and "my note on" not in text.split("### FALSE FAIL: N1")[0]
    assert js.exists()


def test_validate_counts_a_false_pass_and_inconsistency(tmp_path):
    # I say N1 is not grounded; a judge that passes it in one run is a FALSE PASS and unstable
    frozen, ldir = prepared(tmp_path, {"G1": True, "N1": False, "N2": False})
    calls = {"n": 0}

    class Flaky(ScriptedJudge):
        def complete(self, system, user):
            calls["n"] += 1
            if "INVENTED advice one" in user and calls["n"] > 3:   # N1 passes from the second run on
                return RawAnswer(payload={"claims": [], "verdict": "grounded"}, model="fake-judge")
            return super().complete(system, user)

    md, js, m = validate.validate(frozen, "tune", 3, Flaky(), labels_dir=ldir, out_dir=tmp_path / "r")
    assert m["false_pass"] == 2 and m["false_pass_of"] == 6 and m["false_pass_tickets"] == ["N1"]
    assert m["unstable_tickets"] == ["N1"] and m["consistent"] == 2
    text = md.read_text()
    assert "### FALSE PASS: N1 (run 2)" in text and "my note on N1" in text and "**2/6 (33%)**" in text


def test_validate_reports_quote_errors_and_failed_calls_without_hiding_them(tmp_path):
    frozen, ldir = prepared(tmp_path, {"G1": True, "N1": False, "N2": False})

    class Odd(ScriptedJudge):
        def complete(self, system, user):
            if "Lockout clears after 1 hour." in user.split("DRAFT REPLY START")[1]:      # G1
                return RawAnswer(payload={"claims": [{"text": "c", "label": "supported", "evidence_quote": "made up"}],
                                          "verdict": "grounded"}, model="fake-judge")
            if "advice one" in user:
                return RawAnswer(error="TimeoutError: slow", model="fake-judge")
            return super().complete(system, user)

    md, js, m = validate.validate(frozen, "tune", 2, Odd(), labels_dir=ldir, out_dir=tmp_path / "r")
    assert m["quote_errors"] == 2 and m["failed_calls"] == 2 and m["valid"] == 4
    text = md.read_text()
    assert "QUOTE NOT FOUND" in text and "Judge error: TimeoutError: slow" in text and "NO VERDICT: N1" in text
