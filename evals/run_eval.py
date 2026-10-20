"""Run the labelled tickets through the real graph and score them.

    venv/bin/python -m evals.run_eval

This makes REAL Claude and Voyage calls (see README, "Evals"). It never saves a
ticket: it calls the graph directly, with an in-memory checkpointer. The only
database use is the knowledge-base lookup inside the graph.
"""
import argparse
import json
import statistics
import subprocess
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path

from evals.scoring import CHECKS, score_ticket, summarize

DEFAULT_DATASET = "evals/dataset/tickets_v1.jsonl"
DEFAULT_OUT = "evals/results"


def load_dataset(path) -> list:
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


def missing_keys(settings) -> list:
    """Names (never values) of the required keys that are empty."""
    required = {"ANTHROPIC_API_KEY": settings.anthropic_api_key,
                "VOYAGE_API_KEY": settings.voyage_api_key}
    return [name for name, value in required.items() if not (value or "").strip()]


def git_commit() -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, check=True
        )
        return out.stdout.strip() or "unknown"
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


def extract_output(state: dict) -> dict:
    """The fields that get scored, taken from the final (or paused) graph state.

    Same keys that app/api/triage.py reads. Low-confidence tickets have no
    draft_reply and no kb_context, so those two are read leniently.
    """
    classification = state["classification"]
    return {
        "category": classification.category.value,
        "urgency": classification.urgency.value,
        "confidence": classification.confidence,
        "routing_target": state["routing_target"],
        "draft_reply": state.get("draft_reply"),
        "kb_sources": [
            {"topic": m.topic, "distance": m.distance} for m in state.get("kb_context", [])
        ],
        "needs_human_review": state["needs_human_review"],
        "review_reason": state.get("review_reason") or None,
        "paused": "__interrupt__" in state,
        "draft_truncated": bool(state.get("draft_truncated")),
        "kb_failed": bool(state.get("kb_failed")),
    }


def run_ticket(graph, label: dict) -> dict:
    from app.models import TicketIn

    ticket = TicketIn(subject=label["subject"], body=label["body"])
    config = {"configurable": {"thread_id": str(uuid.uuid4())}}
    started = time.perf_counter()
    entry = {"id": label["id"], "label": label, "output": None, "scores": None,
             "latency_seconds": None, "error": None}
    try:
        state = graph.invoke({"ticket": ticket}, config=config)
        entry["output"] = extract_output(state)
        entry["scores"] = score_ticket(label, entry["output"])
    except Exception as exc:  # one bad ticket must not stop the run
        entry["error"] = f"{type(exc).__name__}: {exc}"
    entry["latency_seconds"] = round(time.perf_counter() - started, 3)
    return entry


def run_eval(dataset_path, only=None, graph=None) -> dict:
    """Run the tickets one at a time, in order, and return the full result dict."""
    labels = load_dataset(dataset_path)
    if only:
        known = {label["id"] for label in labels}
        unknown = [i for i in only if i not in known]
        if unknown:
            raise ValueError(f"Unknown ticket id(s) in --only: {', '.join(unknown)}")
        labels = [label for label in labels if label["id"] in only]

    if graph is None:
        from langgraph.checkpoint.memory import MemorySaver

        from app.graph.build import build_triage_graph
        from app.graph.checkpointer import checkpoint_serde

        graph = build_triage_graph(MemorySaver(serde=checkpoint_serde()))

    from app.config import settings

    started_at = datetime.now()
    started = time.perf_counter()
    tickets = []
    for label in labels:
        entry = run_ticket(graph, label)
        tickets.append(entry)
        print(f"{entry['id']}: {'ERROR ' + entry['error'] if entry['error'] else 'done'} "
              f"({entry['latency_seconds']}s)", file=sys.stderr)

    scored = [{"id": t["id"], "scores": t["scores"]} for t in tickets if t["scores"]]
    return {
        "dataset": str(dataset_path),
        "git_commit": git_commit(),
        "model": settings.model_id,
        "started_at": started_at.isoformat(timespec="seconds"),
        "duration_seconds": round(time.perf_counter() - started, 3),
        "summary": summarize(scored),
        "tickets": tickets,
    }


def _ratio(counts: dict) -> str:
    scored = counts["pass"] + counts["fail"]
    text = f"{counts['pass']}/{scored}"
    return text + (f" ({counts['skip']} skipped)" if counts["skip"] else "")


def _fails(result: dict, *names) -> list:
    """(ticket, check name, check dict) for every failed check in `names`."""
    return [(t, n, t["scores"][n]) for t in result["tickets"] if t["scores"]
            for n in names if t["scores"][n]["result"] == "fail"]


def render_markdown(result: dict) -> str:
    summary = result["summary"]
    tickets = result["tickets"]
    lines = [
        "# Eval scorecard",
        "",
        f"- Dataset: `{result['dataset']}`",
        f"- Commit: `{result['git_commit']}`",
        f"- Model: `{result['model']}`",
        f"- Started: {result['started_at']}",
        f"- Duration: {result['duration_seconds']}s",
        f"- Tickets: {len(tickets)} ({sum(1 for t in tickets if t['error'])} errors)",
        "",
        "## Scores (passed/scored)",
        "",
    ]
    for name in CHECKS:
        lines.append(f"- {name}: {_ratio(summary['checks'][name])}")

    lines += ["", "## MISSED FLAGS (should have gone to a human, did not)", ""]
    lines += [f"- {i}" for i in summary["missed_flags"]] or ["None."]

    lines += ["", "## EXTRA FLAGS (flagged, but the label says it should not be)", ""]
    lines += [f"- {i}" for i in summary["extra_flags"]] or ["None."]

    lines += ["", "## REPLY FAILURES", ""]
    reply = _fails(result, "must_include", "must_not_include")
    for t, name, check in reply:
        lines.append(f"- {t['id']} {name}: {check['detail']}")
    if not reply:
        lines.append("None.")

    lines += ["", "## OTHER FAILURES", ""]
    other = _fails(result, "category", "urgency", "kb_topic")
    for t, name, check in other:
        lines.append(f"- {t['id']} {name}: expected {check['expected']!r}, "
                     f"actual {check['actual']!r}")
    if not other:
        lines.append("None.")

    lines += ["", "## ERRORS", ""]
    errors = [t for t in tickets if t["error"]]
    lines += [f"- {t['id']}: {t['error']}" for t in errors] or ["None."]

    latencies = [t["latency_seconds"] for t in tickets if t["latency_seconds"] is not None]
    lines += ["", "## Latency", ""]
    if latencies:
        lines.append(f"- median: {statistics.median(latencies):.2f}s")
        lines.append(f"- max: {max(latencies):.2f}s")
    else:
        lines.append("No tickets ran.")
    return "\n".join(lines) + "\n"


def write_reports(result: dict, out_dir) -> tuple:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    json_path, md_path = out / f"{stamp}.json", out / f"{stamp}.md"
    json_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown(result), encoding="utf-8")
    return json_path, md_path


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Run the eval set through the real graph.")
    parser.add_argument("--dataset", default=DEFAULT_DATASET)
    parser.add_argument("--only", default=None, help="comma-separated ticket ids, e.g. T01,T05")
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args(argv)

    from app.config import settings

    missing = missing_keys(settings)
    if missing:
        print(f"Cannot run the eval: {', '.join(missing)} not set. "
              "Set them in .env or the environment.", file=sys.stderr)
        return 1

    only = [i.strip() for i in args.only.split(",") if i.strip()] if args.only else None
    try:
        result = run_eval(args.dataset, only)
    except (ValueError, OSError) as exc:
        print(f"Cannot run the eval: {exc}", file=sys.stderr)
        return 1

    json_path, md_path = write_reports(result, args.out)
    print(md_path.read_text(encoding="utf-8"))
    print(f"Wrote {json_path} and {md_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
