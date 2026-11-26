"""Freeze, split, label and validate (evals/judge/*) end to end with fakes: no API calls, no database."""
import json
from types import SimpleNamespace

import pytest

from app.models import Category, ClassificationResult, KbMatch, Urgency
from evals.judge import common, freeze_drafts, label, mutate, split, validate
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
def _sentences_of(user):
    block = user.split("DRAFT REPLY START (numbered sentences)\n")[1].split("\nDRAFT REPLY END")[0]
    return block.splitlines()


class ScriptedJudge:
    """Reads the numbered draft: any sentence containing INVENTED is unsupported, the rest are supported."""
    model = "fake-judge"

    def __init__(self):
        self.calls = 0

    def complete(self, system, user):
        self.calls += 1
        items, bad = [], False
        for line in _sentences_of(user):
            n = int(line[1:line.index("]")])
            if "INVENTED" in line:
                items.append({"sentence": n, "label": "unsupported", "reason": "not in the article"})
                bad = True
            else:
                items.append({"sentence": n, "label": "supported", "quotes": ["Lockout clears automatically after 1 hour."]})
        return RawAnswer(payload={"sentences": items, "verdict": "not_grounded" if bad else "grounded"},
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
                return RawAnswer(payload={"sentences": [{"sentence": 1, "label": "not_a_claim"}], "verdict": "grounded"},
                                 model="fake-judge")
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
                return RawAnswer(payload={"sentences": [{"sentence": 1, "label": "supported", "quotes": ["made up"]}],
                                          "verdict": "grounded"}, model="fake-judge")
            if "advice one" in user:
                return RawAnswer(error="TimeoutError: slow", model="fake-judge")
            return super().complete(system, user)

    md, js, m = validate.validate(frozen, "tune", 2, Odd(), labels_dir=ldir, out_dir=tmp_path / "r")
    assert m["quote_errors"] == 2 and m["failed_calls"] == 2 and m["valid"] == 4
    text = md.read_text()
    assert "QUOTE NOT FOUND" in text and "Judge error: TimeoutError: slow" in text and "NO VERDICT: N1" in text


# --- credentials, fail fast, never write an empty freeze -----------------------------------------------
import os  # noqa: E402

from evals import credentials  # noqa: E402
from evals.judge import judge as judge_mod  # noqa: E402


def test_the_judge_client_gets_its_key_from_settings_when_the_environment_has_none(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    backend = judge_mod.AnthropicBackend(SimpleNamespace(
        anthropic_api_key="sk-fake-from-settings", judge_model="", model_id="m", llm_timeout_seconds=5, llm_max_retries=0))
    llm = backend._llm.bound                       # the ChatAnthropic under bind_tools
    assert llm.anthropic_api_key.get_secret_value() == "sk-fake-from-settings"


def test_export_credentials_fills_a_missing_environment_variable_but_never_overrides_one(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("VOYAGE_API_KEY", "from-shell")
    credentials.export_credentials(SimpleNamespace(anthropic_api_key=" from-env-file ", voyage_api_key="from-env-file"))
    assert os.environ["ANTHROPIC_API_KEY"] == "from-env-file"
    assert os.environ["VOYAGE_API_KEY"] == "from-shell"
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    credentials.export_credentials(SimpleNamespace(anthropic_api_key="", voyage_api_key=""))
    assert "ANTHROPIC_API_KEY" not in os.environ


def test_freeze_fails_fast_naming_the_missing_key_before_asking_or_running(tmp_path, capsys):
    g = graph4()
    ds = dataset(tmp_path, ["A"])
    asked = []
    s = SimpleNamespace(anthropic_api_key="x", voyage_api_key=" ", model_id="m", voyage_rpm=3)
    code = freeze_drafts.main(["--dataset", str(ds), "--out", str(tmp_path / "o.jsonl")],
                              input_fn=lambda p: asked.append(p) or "y", graph=g, settings=s)
    err = capsys.readouterr().err
    assert code == 1 and asked == [] and g.calls == 0 and "VOYAGE_API_KEY" in err and "ANTHROPIC_API_KEY" not in err


def test_an_authentication_error_stops_the_run_at_the_first_ticket_and_writes_nothing(tmp_path, capsys):
    err = TypeError("Anthropic authentication failed: no API key or authorization credentials were provided.")
    g = FakeGraph({"s-A": err, "s-B": err, "s-C": err, "s-D": err})
    code, out, _ = run_freeze(tmp_path, "y", g)
    assert code == 1 and g.calls == 1                                   # not 4
    assert not out.exists() and not common.split_path(out).exists()
    assert "rejected the credentials" in capsys.readouterr().err


def test_zero_drafts_writes_no_frozen_and_no_split_file_and_exits_non_zero(tmp_path, capsys):
    g = FakeGraph({f"s-{i}": RuntimeError("model unavailable") for i in "ABCD"})
    code, out, _ = run_freeze(tmp_path, "y", g)
    err = capsys.readouterr().err
    assert code == 1 and g.calls == 4
    assert not out.exists() and not common.split_path(out).exists()
    assert "No ticket produced a draft" in err and "4 of 4 tickets failed" in err and "model unavailable" in err
    g2 = FakeGraph({f"s-{i}": state(None, kb=()) for i in "ABCD"})      # ran fine, but nothing was drafted
    code, out2, _ = run_freeze(tmp_path, "y", g2)
    assert code == 1 and not out2.exists()


def test_validate_stops_at_the_first_authentication_error(tmp_path):
    frozen, ldir = prepared(tmp_path, {"G1": True, "N1": False, "N2": False})

    class Denied:
        model = "m"
        calls = 0

        def complete(self, system, user):
            Denied.calls += 1
            return RawAnswer(error="AuthenticationError: 401", auth_failed=True)

    with pytest.raises(judge_mod.AuthFailed):
        validate.run_judge(Denied(), common.judged(common.load_frozen(frozen)), runs=3)
    assert Denied.calls == 1
    assert judge_mod.is_auth_error(TypeError("Anthropic authentication failed: no API key"))
    assert not judge_mod.is_auth_error(RuntimeError("authentication"))


def test_validate_reports_sentence_level_agreement_and_the_judge_label_next_to_my_numbers(tmp_path):
    spec = {"G1": ("Fine one.", False), "X1": ("Hi.\nINVENTED one.\nOk two.\nINVENTED three.", False),
            "X2": ("INVENTED a.\nOk b.", False), "X3": ("Ok a.\nOk b.", False), "X4": ("INVENTED a.\nINVENTED b.\nOk c.", False)}
    frozen = make_frozen(tmp_path, spec)
    split.save_split(frozen, {"tune": list(spec), "test": []}, basis="test")
    ldir = tmp_path / "labels"
    mine = {"G1": (True, []), "X1": (False, [2, 3]), "X2": (False, [1]), "X3": (False, [2]), "X4": (False, [])}
    common.write_jsonl(common.labels_path(frozen, ldir), [
        {"id": i, "grounded": g, "unsupported_sentences": n, "note": f"note {i}"} for i, (g, n) in mine.items()])
    md, js, m = validate.validate(frozen, "tune", 1, ScriptedJudge(), labels_dir=ldir, out_dir=tmp_path / "r")
    # X1: judge flags 2,4 vs mine 2,3 -> overlap; X2: 1 vs 1 -> exact; X3: judge flags nothing -> none (and a FALSE PASS);
    # X4: I marked no numbers -> not comparable
    assert m["sentence_level"] == {"exact": 1, "overlap": 1, "none": 1, "not_marked": 1}
    assert m["false_pass_tickets"] == ["X3"]
    text = md.read_text()
    assert "## Sentence level" in text and "exactly the sentences I flagged: 1/4" in text
    assert text.index("FALSE PASS (judge") < text.index("## Sentence level")
    block = text.split("### FALSE PASS: X3")[1].split("###")[0]
    assert "My unsupported sentence numbers: 2" in block and "Judge flagged (unsupported): (none)" in block
    assert "- *[2] supported" in block and "-  [1] supported" in block            # * marks the sentence I flagged


def test_sentence_match_cases():
    assert validate.sentence_match([2, 3], [3, 2]) == "exact"
    assert validate.sentence_match([2, 3], [3, 4]) == "overlap"
    assert validate.sentence_match([2], []) == "none"
    assert validate.sentence_match([], [1]) == "not_marked"


def test_an_answer_that_skips_a_sentence_is_listed_as_an_invalid_output_not_fixed(tmp_path):
    frozen, ldir = prepared(tmp_path, {"G1": True, "N1": False, "N2": False})

    class Skips(ScriptedJudge):
        def complete(self, system, user):
            ans = super().complete(system, user)
            ans.payload["sentences"] = []                 # covers no sentence at all
            return ans

    md, js, m = validate.validate(frozen, "tune", 1, Skips(), labels_dir=ldir, out_dir=tmp_path / "r")
    assert m["failed_calls"] == 3 and m["valid"] == 0
    assert "invalid judge output: missing sentence(s) [1]" in md.read_text()


def test_split_all_runs_every_labelled_draft_and_the_report_says_the_test_split_is_used_up(tmp_path):
    frozen, ldir = prepared(tmp_path, {"G1": True, "G2": True, "N1": False, "N2": False})
    judge = ScriptedJudge()
    md, js, m = validate.validate(frozen, "all", 1, judge, labels_dir=ldir, out_dir=tmp_path / "r")
    assert judge.calls == 4 and m["tickets"] == 4              # tune AND test tickets together
    text = md.read_text()
    assert "split: all (dev). The test split was run once on 2026-11-24 and is no longer held out." in text
    assert md.name.startswith("judge-all-")
    md2, _, _ = validate.validate(frozen, "tune", 1, ScriptedJudge(), labels_dir=ldir, out_dir=tmp_path / "r2")
    assert "no longer held out" not in md2.read_text()


def test_split_all_refuses_if_any_judged_draft_is_unlabelled(tmp_path):
    frozen, ldir = prepared(tmp_path, {"G1": True, "N1": False, "N2": False})          # G2 unlabelled
    with pytest.raises(validate.Refused, match="G2"):
        validate.validate(frozen, "all", 1, ScriptedJudge(), labels_dir=ldir, out_dir=tmp_path / "r")


# --- the number check in the report ------------------------------------------------------------------------
def test_validate_reports_number_errors_next_to_quote_errors(tmp_path):
    frozen, ldir = prepared(tmp_path, {"G1": True, "N1": False, "N2": False})
    common.write_jsonl(frozen, [{**r, "subject": "help", "body": "please help"} for r in common.load_frozen(frozen)])

    class NoNumber(ScriptedJudge):
        def complete(self, system, user):
            if "Lockout clears after 1 hour." in user.split("DRAFT REPLY START")[1]:      # G1
                return RawAnswer(payload={"sentences": [{"sentence": 1, "label": "supported",
                                                         "quotes": ["Lockout clears automatically"]}],
                                          "verdict": "grounded"}, model="fake-judge")
            return super().complete(system, user)

    md, js, m = validate.validate(frozen, "tune", 2, NoNumber(), labels_dir=ldir, out_dir=tmp_path / "r")
    assert m["number_errors"] == 2 and m["quote_errors"] == 0
    text = md.read_text()
    assert "Number errors (judge said supported, but a number of the sentence is in none of its quotes" in text
    assert text.index("Quote verifier errors") < text.index("Number errors")
    assert "NUMBER NOT IN QUOTES: 1, counted unsupported" in text and "FALSE FAIL: G1" in text


# --- the mutation set (evals/judge/mutate.py) ----------------------------------------------------------------
SOURCE = common.FROZEN_DIR / "drafts_2026-11-24.jsonl"
DATA = mutate.DEFAULT_DATA
MUTANTS = common.FROZEN_DIR / "mutants_2026-11-24.jsonl"
MUTANT_LABELS = common.LABELS_DIR / "mutants_2026-11-24.labels.jsonl"


def _built():
    data = json.loads(DATA.read_text(encoding="utf-8"))
    return data, mutate.build(common.load_frozen(SOURCE), data)


def test_mutate_is_deterministic_and_the_committed_files_are_what_it_builds():
    data, (frozen, labels) = _built()
    again = mutate.build(common.load_frozen(SOURCE), data)
    assert (frozen, labels) == again
    assert MUTANTS.read_text(encoding="utf-8") == mutate._dump(frozen)
    assert MUTANT_LABELS.read_text(encoding="utf-8") == mutate._dump(labels)


def test_every_mutant_differs_from_its_source_in_exactly_the_recorded_sentence_and_the_label_matches():
    data, (frozen, labels) = _built()
    source = {r["id"]: r for r in common.load_frozen(SOURCE)}
    lab = {r["id"]: r for r in labels}
    mutants = [r for r in frozen if r["mutation"]]
    assert len(mutants) == len(data["mutants"]) and 20 <= len(mutants) <= 25
    for row in mutants:
        m = row["mutation"]
        before, after = common.split_sentences(source[m["source"]]["draft"]), common.split_sentences(row["draft"])
        n = m["sentence"]
        if m["op"] == "replace":
            assert len(after) == len(before) and after[n - 1] == m["mutated"] and before[n - 1] == m["original"]
            assert [a for i, a in enumerate(after) if i != n - 1] == [b for i, b in enumerate(before) if i != n - 1]
        else:
            assert len(after) == len(before) + 1 and after[n - 1] == m["mutated"] and m["original"] is None
            assert after[:n - 1] + after[n:] == before
        assert row["kb_articles"] == source[m["source"]]["kb_articles"] and row["subject"] == source[m["source"]]["subject"]
        assert lab[row["id"]] == {**lab[row["id"]], "grounded": False, "unsupported_sentences": [n], "provenance": "planted"}
        assert m["expected"] == "not grounded"


def test_controls_are_the_unmutated_source_drafts_labelled_grounded_and_the_notes_say_they_are_dev():
    data, (frozen, labels) = _built()
    source = {r["id"]: r for r in common.load_frozen(SOURCE)}
    controls = [r for r in frozen if r["mutation"] is None]
    assert [r["id"] for r in controls] == [f"C-{t}" for t in data["controls"]] and len(controls) == 9
    for r in controls:
        assert r["draft"] == source[r["source_ticket"]]["draft"]
    lab = {r["id"]: r for r in labels}
    assert all(lab[r["id"]]["grounded"] and lab[r["id"]]["provenance"] == "planted" for r in controls)
    assert all(r["provenance"] == "planted" for r in labels) and len(labels) == len(frozen)
    assert "DEV drafts" in validate.MUTANTS_NOTE


def test_the_mutation_set_covers_every_type_and_a_third_are_subtle():
    data, _ = _built()
    ms = data["mutants"]
    assert {m["type"] for m in ms} == {"number_changed", "added_step", "invented_account_claim", "invented_promise",
                                       "reversed_fact", "unsupported_explanation", "invented_app_path"}
    assert sum(m["subtlety"] == "subtle" for m in ms) >= len(ms) / 3
    assert {m["subtlety"] for m in ms} == {"obvious", "subtle"}
    assert {m["source"] for m in ms if m["type"] == "invented_app_path"} == {"T11", "T12"}
    assert {m["source"] for m in ms} <= set(data["controls"]) and len({m["id"] for m in ms}) == len(ms)


@pytest.mark.parametrize("change,fragment", [
    ({"sentence": 99}, "does not exist"),
    ({"text": "One sentence. And another."}, "ONE sentence"),
    ({"text": "Thank you for getting in touch."}, "equals the original"),   # T01 sentence 1
    ({"expected": "grounded"}, "expected must be"),
    ({"op": "swap"}, "op must be"),
    ({"source": "T99"}, "not a judged draft"),
])
def test_bad_mutations_are_refused(change, fragment):
    data = {"date": "2026-11-24", "controls": [],
            "mutants": [{"id": "X1", "source": "T01", "op": "replace", "sentence": 1, "type": "t", "subtlety": "obvious",
                         "expected": "not grounded", "text": "Hello there."} | change]}
    with pytest.raises(mutate.BadMutation, match=fragment):
        mutate.build(common.load_frozen(SOURCE), data)


def test_an_added_sentence_must_be_numbered_inside_the_draft_and_stays_on_the_same_line():
    rows = [{"id": "A", "subject": "s", "body": "b", "kb_articles": [], "draft": "Hi.\nOne. Two.\nBye.", "judged": True}]
    spec = lambda n: {"date": "d", "controls": [], "mutants": [{"id": "X", "source": "A", "op": "add", "sentence": n,
                      "type": "t", "subtlety": "subtle", "expected": "not grounded", "text": "New."}]}
    frozen, labels = mutate.build(rows, spec(3))
    assert frozen[0]["draft"] == "Hi.\nOne. New. Two.\nBye.\n" and labels[0]["unsupported_sentences"] == [3]
    for bad in (1, 6):
        with pytest.raises(mutate.BadMutation, match="2..5"):
            mutate.build(rows, spec(bad))


def test_frozen_mutant_files_are_never_overwritten_with_different_content(tmp_path):
    out, lab = tmp_path / "mutants_x.jsonl", tmp_path / "mutants_x.labels.jsonl"
    mutate.run(DATA, SOURCE, out, lab)
    before = out.read_text(encoding="utf-8")
    mutate.run(DATA, SOURCE, out, lab)                                   # identical content: fine
    assert out.read_text(encoding="utf-8") == before == MUTANTS.read_text(encoding="utf-8")
    out.write_text("changed\n", encoding="utf-8")
    with pytest.raises(mutate.BadMutation, match="never overwritten"):
        mutate.run(DATA, SOURCE, out, lab)


class AllClear:
    """A judge that calls every sentence not_a_claim (so it passes everything)."""
    model = "fake-judge"

    def __init__(self):
        self.calls = 0

    def complete(self, system, user):
        self.calls += 1
        items = [{"sentence": int(line[1:line.index("]")]), "label": "not_a_claim"} for line in _sentences_of(user)]
        return RawAnswer(payload={"sentences": items, "verdict": "grounded"}, input_tokens=10, output_tokens=5,
                         model="fake-judge")


def test_validate_all_works_on_the_mutants_file_without_a_split_file_and_says_it_is_the_mutation_set(tmp_path):
    assert not common.split_path(MUTANTS).exists()
    judge = AllClear()
    md, js, m = validate.validate(MUTANTS, "all", 1, judge, out_dir=tmp_path / "r")
    assert judge.calls == 32 and m["tickets"] == 32
    assert m["false_pass"] == 23 and m["false_pass_of"] == 23 and m["false_fail"] == 0 and m["false_fail_of"] == 9
    text = md.read_text(encoding="utf-8")
    assert validate.MUTANTS_NOTE in text and "no longer held out" not in text
    assert md.name.startswith("judge-all-")
    with pytest.raises(validate.Refused, match="No split file"):
        validate.select_split(MUTANTS, "tune")


def test_validate_cli_takes_frozen_with_split_all(tmp_path, capsys):
    assert validate.main(["--split", "all", "--runs", "1", "--frozen", str(MUTANTS), "--out", str(tmp_path / "r")],
                         backend=AllClear()) == 0
    assert "MUTATION SET" in capsys.readouterr().out


# --- the mutant breakdown in the report ------------------------------------------------------------------------
class MutantJudge:
    """Scripted by sentence text: '24 hours — you' -> supported with a real quote lacking the number (number
    check); 'expires after 24 hours' -> supported with a made-up quote (quote check); 'one-month credit' ->
    unsupported (the model); everything else not_a_claim (missed)."""
    model = "fake-judge"

    def complete(self, system, user):
        items = []
        for line in _sentences_of(user):
            n = int(line[1:line.index("]")])
            if "24 hours — you" in line:
                it = {"sentence": n, "label": "supported", "quotes": ["Lockout clears automatically after"]}
            elif "expires after 24 hours" in line:
                it = {"sentence": n, "label": "supported", "quotes": ["made up quote"]}
            elif "one-month credit" in line:
                it = {"sentence": n, "label": "unsupported"}
            else:
                it = {"sentence": n, "label": "not_a_claim"}
            items.append(it)
        return RawAnswer(payload={"sentences": items, "verdict": "grounded"}, input_tokens=1, output_tokens=1,
                         model="fake-judge")


def test_mutant_report_breaks_down_by_type_and_subtlety_and_says_what_caught_each():
    md, js, m = validate.validate(MUTANTS, "all", 2, MutantJudge(), out_dir=tmp_dir())
    b = m["mutation"]
    assert (b["caught"], b["missed"], b["total"]) == (6, 40, 46)          # 3 mutants caught, 2 runs each
    assert b["number_only"] == 2 and b["causes"] == {"model": 2, "quote_check": 2, "number_check": 2, "other_sentence": 0}
    assert b["false_pass_rate"] == pytest.approx(40 / 46) and b["false_pass_rate_without_number_only"] == pytest.approx(42 / 46)
    assert b["by_type"]["number_changed"] == {"caught": 4, "missed": 6}
    assert b["by_type"]["invented_promise"] == {"caught": 2, "missed": 4}
    assert b["by_subtlety"]["subtle"]["caught"] == 0 and b["by_subtlety"]["obvious"]["caught"] == 6
    assert b["per_mutant"]["M01"]["causes"] == {"number_check": 2} and b["per_mutant"]["M03"]["causes"] == {"quote_check": 2}
    assert b["per_mutant"]["M12"]["causes"] == {"model": 2}
    text = md.read_text(encoding="utf-8")
    assert "## Mutants: caught or missed, and by what" in text
    assert "**40/46 (87%)**" in text and "**42/46 (91%)**" in text
    assert "| type: number_changed | 4 | 6 |" in text and "| subtlety: subtle | 0 |" in text
    assert "- M01 (number_changed, obvious): caught 2/2; by number check (2)" in text
    assert "- M12 (invented_promise, obvious): caught 2/2; by model (2)" in text
    assert "- M02 (number_changed, subtle): caught 0/2" in text


def test_no_mutant_section_for_ordinary_drafts(tmp_path):
    frozen, ldir = prepared(tmp_path, {"G1": True, "N1": False, "N2": False})
    md, _, m = validate.validate(frozen, "tune", 1, ScriptedJudge(), labels_dir=ldir, out_dir=tmp_path / "r")
    assert m["mutation"] is None and "Mutants: caught or missed" not in md.read_text()


def tmp_dir():
    import tempfile
    return tempfile.mkdtemp()


# --- out of credit is fatal, like an authentication error ------------------------------------------------------
CREDIT = ("Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', 'message': "
          "'Your credit balance is too low to access the Anthropic API.'}}")


def test_is_billing_error_matches_only_a_400_about_the_credit_balance():
    class BadRequestError(Exception):
        status_code = 400

    assert judge_mod.is_billing_error(BadRequestError(CREDIT))
    assert judge_mod.is_billing_error(RuntimeError(CREDIT))                       # message alone with "400" in it
    assert not judge_mod.is_billing_error(BadRequestError("max_tokens is too large"))
    assert not judge_mod.is_billing_error(RuntimeError("credit balance is too low"))     # no 400
    assert not judge_mod.is_billing_error(TypeError("Anthropic authentication failed: no API key"))


def test_validate_stops_at_once_when_the_credit_runs_out_and_writes_no_report(tmp_path, capsys, monkeypatch):
    frozen, ldir = prepared(tmp_path, {"G1": True, "G2": True, "N1": False, "N2": False})
    real_select, real_validate = validate.select_split, validate.validate          # point both at my temp labels
    monkeypatch.setattr(validate, "select_split", lambda f, s, d=None: real_select(f, s, ldir))
    monkeypatch.setattr(validate, "validate", lambda *a, **k: real_validate(*a, labels_dir=ldir, **k))
    calls = {"n": 0}

    class OutOfCredit(ScriptedJudge):
        def complete(self, system, user):
            calls["n"] += 1
            if calls["n"] >= 3:
                return RawAnswer(error="BadRequestError: " + CREDIT, billing_failed=True)
            return super().complete(system, user)

    out = tmp_path / "r"
    code = validate.main(["--split", "all", "--runs", "3", "--frozen", str(frozen), "--out", str(out)],
                         backend=OutOfCredit())
    err = capsys.readouterr().err
    assert code == 1 and calls["n"] == 3                                  # stopped at the first failing call
    assert "no credit left" in err and "No report written" in err and "rejected the credentials" not in err
    assert not out.exists() or not list(out.iterdir())
    with pytest.raises(judge_mod.BillingFailed):
        validate.run_judge(OutOfCredit(), common.judged(common.load_frozen(frozen)), runs=1)


def test_the_backend_marks_a_credit_error_as_billing_not_as_authentication():
    class BadRequestError(Exception):
        status_code = 400

    class Llm:
        def invoke(self, _):
            raise BadRequestError(CREDIT)

    backend = judge_mod.AnthropicBackend.__new__(judge_mod.AnthropicBackend)
    backend.model, backend._llm = "m", Llm()
    ans = backend.complete("s", "u")
    assert ans.billing_failed and not ans.auth_failed and ans.payload is None


def test_freeze_stops_at_once_when_the_credit_runs_out_and_writes_nothing(tmp_path, capsys):
    err = RuntimeError(CREDIT)
    g = FakeGraph({"s-A": err, "s-B": err, "s-C": err, "s-D": err})
    code, out, _ = run_freeze(tmp_path, "y", g)
    assert code == 1 and g.calls == 1
    assert not out.exists() and not common.split_path(out).exists()
    text = capsys.readouterr().err
    assert "no credit left" in text and "Nothing was written" in text and "rejected the credentials" not in text
