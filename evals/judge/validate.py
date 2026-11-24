"""Compare the judge with my hand labels on one half of the frozen drafts.

    venv/bin/python -m evals.judge.validate --split tune --runs 3 [--frozen FILE]

Runs the judge on every judged draft of the split N times (REAL Claude calls, one per draft per
run) and compares each verdict with my label. It REFUSES to run unless every ticket of the split is
labelled. Report (markdown + json) goes to evals/results/judge-<split>-<timestamp>.*; the FALSE PASS
rate (the judge said "grounded" where I said not: the dangerous error) is shown first, then every
disagreement with the judge's per-sentence labels next to my flagged sentences and my note.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from evals.judge.common import LABELS_DIR, judged, labels_path, latest_frozen, load_frozen, load_labels, split_path
from evals.judge.judge import AuthFailed, JudgeResult, judge_draft

DEFAULT_OUT = "evals/results"


ALL_SPLIT_NOTE = "split: all (dev). The test split was run once on 2026-11-24 and is no longer held out."


class Refused(Exception):
    """Validation cannot start (missing split, tickets or labels). The message says what to do."""


def truth_of(label: dict) -> str:
    return "grounded" if label["grounded"] else "not_grounded"


def select_split(frozen_path, split_name: str, labels_dir=LABELS_DIR) -> tuple[list[dict], dict]:
    """(judged rows of the split, my labels for them), or Refused."""
    sp = split_path(frozen_path)
    if not sp.exists():
        raise Refused(f"No split file {sp}. Freeze the drafts first.")
    split = json.loads(sp.read_text(encoding="utf-8"))
    by_id = {r["id"]: r for r in judged(load_frozen(frozen_path))}
    ids = sorted(by_id) if split_name == "all" else split[split_name]
    unknown = [i for i in ids if i not in by_id]
    if unknown:
        raise Refused(f"The split lists tickets that are not judged drafts in the frozen file: {', '.join(unknown)}")
    labels = load_labels(labels_path(frozen_path, labels_dir))
    missing = [i for i in ids if i not in labels]
    if missing:
        raise Refused(f"Refusing to run: {len(missing)} of {len(ids)} tickets in the {split_name} split are not "
                      f"labelled yet: {', '.join(missing)}. Run: venv/bin/python -m evals.judge.label {frozen_path}")
    return [by_id[i] for i in ids], {i: labels[i] for i in ids}


def run_judge(backend, rows: list[dict], runs: int, progress=None) -> dict[str, list[JudgeResult]]:
    results: dict[str, list[JudgeResult]] = {r["id"]: [] for r in rows}
    for n in range(runs):
        for row in rows:
            res = judge_draft(backend, subject=row["subject"], body=row["body"],
                              articles=row["kb_articles"], draft=row["draft"])
            results[row["id"]].append(res)
            if progress:
                progress(n + 1, row["id"], res)
    return results


def sentence_match(mine: list[int], judge: list[int]) -> str:
    """For a draft I labelled not grounded: did the judge flag the same sentence numbers?
    exact = the same set; overlap = some in common but not the same; none = nothing in common;
    not_marked = I marked no sentence numbers, so there is nothing to compare."""
    if not mine:
        return "not_marked"
    a, b = set(mine), set(judge)
    if a == b:
        return "exact"
    return "overlap" if a & b else "none"


def _rate(num: int, den: int):
    return None if den == 0 else num / den


def compute(rows: list[dict], labels: dict, results: dict[str, list[JudgeResult]]) -> dict:
    matrix = {"grounded": {"grounded": 0, "not_grounded": 0}, "not_grounded": {"grounded": 0, "not_grounded": 0}}
    failed = quote_errors = mismatches = 0
    input_tokens = output_tokens = 0
    cost: float | None = 0.0
    models = set()
    unstable, false_pass_tickets = [], []
    sentence_level = {"exact": 0, "overlap": 0, "none": 0, "not_marked": 0}
    from app.usage import cost_usd

    for row in rows:
        truth = truth_of(labels[row["id"]])
        verdicts = []
        for res in results[row["id"]]:
            models.add(res.model)
            input_tokens += res.input_tokens
            output_tokens += res.output_tokens
            c = cost_usd(res.model, res.input_tokens, res.output_tokens)
            cost = None if (c is None or cost is None) else cost + c
            quote_errors += len(res.quote_errors)
            mismatches += res.verdict_mismatch
            if res.verdict is None:
                failed += 1
                continue
            verdicts.append(res.verdict)
            matrix[truth][res.verdict] += 1
            if truth == "not_grounded":
                sentence_level[sentence_match(labels[row["id"]]["unsupported_sentences"], res.flagged)] += 1
        if len(set(verdicts)) > 1:
            unstable.append(row["id"])
        if truth == "not_grounded" and "grounded" in verdicts:
            false_pass_tickets.append(row["id"])

    valid = sum(sum(r.values()) for r in matrix.values())
    n_not = sum(matrix["not_grounded"].values())
    n_ok = sum(matrix["grounded"].values())
    agree = matrix["grounded"]["grounded"] + matrix["not_grounded"]["not_grounded"]
    return {
        "matrix": matrix, "valid": valid, "agreement": _rate(agree, valid), "agree": agree,
        "false_pass": matrix["not_grounded"]["grounded"], "false_pass_of": n_not,
        "false_pass_rate": _rate(matrix["not_grounded"]["grounded"], n_not),
        "false_fail": matrix["grounded"]["not_grounded"], "false_fail_of": n_ok,
        "false_fail_rate": _rate(matrix["grounded"]["not_grounded"], n_ok),
        "false_pass_tickets": false_pass_tickets, "sentence_level": sentence_level,
        "unstable_tickets": unstable, "consistent": len(rows) - len(unstable), "tickets": len(rows),
        "failed_calls": failed, "quote_errors": quote_errors, "verdict_mismatches": mismatches,
        "input_tokens": input_tokens, "output_tokens": output_tokens, "cost_usd": cost,
        "models": sorted(m for m in models if m),
    }


def _pct(rate) -> str:
    return "n/a" if rate is None else f"{rate:.0%}"


def disagreements(rows: list[dict], labels: dict, results: dict[str, list[JudgeResult]]) -> list[dict]:
    out = []
    for row in rows:
        truth = truth_of(labels[row["id"]])
        for n, res in enumerate(results[row["id"]], start=1):
            if res.verdict != truth:
                out.append({"id": row["id"], "run": n, "truth": truth, "judge": res.verdict, "result": res, "row": row,
                            "label": labels[row["id"]]})
    # false passes first
    out.sort(key=lambda d: (d["truth"] != "not_grounded" or d["judge"] != "grounded", d["id"], d["run"]))
    return out


def render_markdown(meta: dict, m: dict, diffs: list[dict]) -> str:
    L = [f"# Judge validation: {meta['split']} split", ""]
    if meta["split"] == "all":
        L += [ALL_SPLIT_NOTE, ""]
    L += [
         f"- Judge model: `{', '.join(m['models']) or meta['judge_model']}`",
         f"- Frozen drafts: `{meta['frozen']}` (commit `{meta['frozen_commit']}`, drafter `{meta['drafter_model']}`)",
         f"- Eval code commit: `{meta['git_commit']}`",
         f"- Started: {meta['started_at']}",
         f"- Tickets: {m['tickets']}, runs per ticket: {meta['runs']}, judgements: {m['valid'] + m['failed_calls']}", "",
         "## FALSE PASS (judge says grounded, I said NOT grounded). The dangerous error", ""]
    L.append(f"- False pass rate: **{m['false_pass']}/{m['false_pass_of']} ({_pct(m['false_pass_rate'])})** of the judgements on drafts I labelled not grounded")
    L.append("- Tickets where at least one run falsely passed: " + (", ".join(m["false_pass_tickets"]) or "none"))
    L += ["", "## Agreement", "",
          f"- Agreement with my labels: {m['agree']}/{m['valid']} ({_pct(m['agreement'])})",
          f"- False fail (judge says not grounded, I said grounded): {m['false_fail']}/{m['false_fail_of']} ({_pct(m['false_fail_rate'])})",
          "", "Confusion matrix (rows: my label, columns: judge verdict, all runs counted):", "",
          "| I said \\ judge said | grounded | not_grounded |", "|---|---|---|"]
    for t in ("grounded", "not_grounded"):
        L.append(f"| {t} | {m['matrix'][t]['grounded']} | {m['matrix'][t]['not_grounded']} |")
    sl = m["sentence_level"]
    total = sum(sl.values())
    L += ["", "## Sentence level (drafts I labelled NOT grounded, every run)", "",
          f"- Judge flagged exactly the sentences I flagged: {sl['exact']}/{total}",
          f"- Overlap (some of the same sentences, not identical): {sl['overlap']}/{total}",
          f"- None of my sentences flagged: {sl['none']}/{total}",
          f"- I marked no sentence numbers (not comparable): {sl['not_marked']}/{total}",
          "(judgements with no verdict are left out)"]
    L += ["", "## Consistency, quote errors, cost", "",
          f"- Same verdict in every run: {m['consistent']}/{m['tickets']} tickets" +
          (f" (unstable: {', '.join(m['unstable_tickets'])})" if m["unstable_tickets"] else ""),
          f"- Quote verifier errors (judge said supported, the quote is not in the article; counted unsupported): {m['quote_errors']}",
          f"- Judge verdict contradicted its own sentences (sentences win): {m['verdict_mismatches']}",
          f"- Judge calls that failed or did not validate (no verdict, left out of the numbers above): {m['failed_calls']}",
          f"- Tokens: {m['input_tokens']:,} in, {m['output_tokens']:,} out; cost (estimate): " +
          ("unknown (model has no price)" if m["cost_usd"] is None else f"${m['cost_usd']:.4f}"),
          "", f"## Disagreements to read ({len(diffs)})", ""]
    if not diffs:
        L.append("None.")
    for d in diffs:
        res, row, lab = d["result"], d["row"], d["label"]
        kind = "FALSE PASS" if (d["truth"] == "not_grounded" and d["judge"] == "grounded") else (
            "FALSE FAIL" if d["judge"] == "not_grounded" else "NO VERDICT")
        L += [f"### {kind}: {d['id']} (run {d['run']}): I said {d['truth']}, judge said {d['judge'] or 'nothing'}", ""]
        if res.error:
            L += [f"Judge error: {res.error}", ""]
        mine = set(lab["unsupported_sentences"])
        L += ["My note: " + (lab.get("note") or "(none)"),
              "My unsupported sentence numbers: " + (", ".join(str(n) for n in sorted(mine)) or "(none marked)"),
              "Judge flagged (unsupported): " + (", ".join(str(n) for n in res.flagged) or "(none)"), "",
              "Sentence by sentence (judge's label; * = I flagged it):", ""]
        if res.sentences:
            for c in res.sentences:
                star = "*" if c.number in mine else " "
                flag = " **[QUOTE NOT FOUND, counted unsupported]**" if c.quote_error else ""
                quote = "".join(f' quote: "{q}"' for q in c.quotes)
                reason = f" ({c.reason})" if c.reason else ""
                L.append(f"- {star}[{c.number}] {c.label}{flag}{reason}: {c.text}{quote}")
        else:
            L.append("- (no usable judge answer)")
        L.append("")
    return "\n".join(L) + "\n"


def write_report(meta: dict, m: dict, diffs: list[dict], out_dir) -> tuple[Path, Path]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = f"judge-{meta['split']}-{stamp}"
    md, js = out / f"{base}.md", out / f"{base}.json"
    md.write_text(render_markdown(meta, m, diffs), encoding="utf-8")
    slim = [{k: d[k] for k in ("id", "run", "truth", "judge")} for d in diffs]
    js.write_text(json.dumps({"meta": meta, "metrics": m, "disagreements": slim}, indent=2), encoding="utf-8")
    return md, js


def validate(frozen_path, split_name: str, runs: int, backend, labels_dir=LABELS_DIR, out_dir=DEFAULT_OUT,
             progress=None) -> tuple[Path, Path, dict]:
    rows, labels = select_split(frozen_path, split_name, labels_dir)
    started = datetime.now().isoformat(timespec="seconds")
    results = run_judge(backend, rows, runs, progress)
    m = compute(rows, labels, results)
    from evals.run_eval import git_commit

    meta = {"split": split_name, "runs": runs, "frozen": str(frozen_path), "judge_model": backend.model,
            "frozen_commit": rows[0].get("git_commit", "unknown") if rows else "unknown",
            "drafter_model": (rows[0].get("models") or {}).get("drafter", "unknown") if rows else "unknown",
            "git_commit": git_commit(), "started_at": started}
    md, js = write_report(meta, m, disagreements(rows, labels, results), out_dir)
    return md, js, m


def main(argv=None, *, backend=None) -> int:
    parser = argparse.ArgumentParser(description="Validate the judge against my labels.")
    parser.add_argument("--split", choices=("tune", "test", "all"), required=True)
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--frozen", default=None, help="default: the latest frozen file")
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args(argv)
    if args.runs < 1:
        print("--runs must be at least 1", file=sys.stderr)
        return 1
    frozen = Path(args.frozen) if args.frozen else latest_frozen()
    if frozen is None or not Path(frozen).exists():
        print("No frozen drafts file. Run: venv/bin/python -m evals.judge.freeze_drafts", file=sys.stderr)
        return 1
    try:
        select_split(frozen, args.split)  # refuse BEFORE building a backend or spending anything
    except Refused as exc:
        print(str(exc), file=sys.stderr)
        return 1
    if backend is None:
        from app.config import settings
        from evals.judge.judge import AnthropicBackend

        if not (settings.anthropic_api_key or "").strip():
            print("Cannot run the judge: ANTHROPIC_API_KEY not set.", file=sys.stderr)
            return 1
        backend = AnthropicBackend(settings)
    try:
        md, js, _ = validate(frozen, args.split, args.runs, backend, out_dir=args.out,
                             progress=lambda n, tid, r: print(f"run {n} {tid}: {r.verdict or 'ERROR'}", file=sys.stderr))
    except AuthFailed as exc:
        print(f"Stopped: the Anthropic API rejected the credentials ({exc}). No report written.", file=sys.stderr)
        return 1
    print(md.read_text(encoding="utf-8"))
    print(f"Wrote {md} and {js}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
