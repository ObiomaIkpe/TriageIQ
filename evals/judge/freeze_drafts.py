"""Run the real pipeline ONCE over the latest labelled dataset and save the drafts, so every judge
run grades identical text.

    venv/bin/python -m evals.judge.freeze_drafts            # prints the estimated cost, asks y/N

REAL Claude and Voyage calls (the same as `evals.run_eval`). It saves no tickets: the graph runs
with an in-memory checkpointer. Output: evals/judge/frozen/drafts_<date>.jsonl and, next to it,
the tune/test split (drafts_<date>.split.json). See evals/judge/common.py for the file format.
"""
from __future__ import annotations

import argparse
import re
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path

from evals.judge.common import FROZEN_DIR, judged, write_jsonl
from evals.judge.split import SEED, proxy_stratum, make_split, save_split
from evals.credentials import export_credentials, missing_keys
from evals.judge.judge import AuthFailed, BillingFailed, is_auth_error, is_billing_error
from evals.run_eval import git_commit, load_dataset
from evals.scoring import reply_checks, summarize_reply_checks

DATASET_DIR = Path("evals/dataset")

# A deliberately generous guess per ticket (classify + grade + draft + critique): input includes the
# prompts, the ticket and up to 3 KB articles. The real cost is printed afterwards from the usage the
# run measured.
EST_INPUT_TOKENS_PER_TICKET = 5000
EST_OUTPUT_TOKENS_PER_TICKET = 800


def latest_dataset(dataset_dir=DATASET_DIR) -> Path:
    found = []
    for p in Path(dataset_dir).glob("tickets_v*.jsonl"):
        m = re.fullmatch(r"tickets_v(\d+)\.jsonl", p.name)
        if m:
            found.append((int(m.group(1)), p))
    if not found:
        raise FileNotFoundError(f"no tickets_v*.jsonl in {dataset_dir}")
    return max(found)[1]


def estimate_cost(n_tickets: int, model: str) -> float | None:
    from app.usage import cost_usd

    return cost_usd(model, n_tickets * EST_INPUT_TOKENS_PER_TICKET, n_tickets * EST_OUTPUT_TOKENS_PER_TICKET)


def freeze_one(graph, label: dict, meta: dict) -> dict:
    """Run one ticket and return its frozen record (an error is recorded, never raised)."""
    from app import usage
    from app.models import TicketIn

    ticket = TicketIn(subject=label["subject"], body=label["body"])
    config = {"configurable": {"thread_id": str(uuid.uuid4())}}
    record = {"id": label["id"], "subject": label["subject"], "body": label["body"],
              "kb_articles": [], "draft": None, "judged": False, "category": None,
              "needs_human_review": None, "review_reason": None, "error": None, **meta}
    started = time.perf_counter()
    try:
        with usage.collect() as collector:
            state = graph.invoke({"ticket": ticket}, config=config)
        # kb_context is the list AFTER the relevance grader: exactly what the drafter received.
        record["kb_articles"] = [{"topic": m.topic, "content": m.content, "distance": m.distance}
                                 for m in state.get("kb_context", [])]
        record["draft"] = state.get("draft_reply")
        record["judged"] = bool((record["draft"] or "").strip())
        record["category"] = state["classification"].category.value
        record["needs_human_review"] = bool(state["needs_human_review"])
        record["review_reason"] = state.get("review_reason") or None
        record["usage"] = collector.summary()
    except Exception as exc:
        if is_billing_error(exc):
            raise BillingFailed(f"{type(exc).__name__}: {str(exc)[:200]}") from exc
        if is_auth_error(exc):
            raise AuthFailed(f"{type(exc).__name__}: {str(exc)[:200]}") from exc
        record["error"] = f"{type(exc).__name__}: {exc}"
    record["latency_seconds"] = round(time.perf_counter() - started, 3)
    return record


def freeze(dataset_path, graph, meta: dict, only=None, progress=None) -> list[dict]:
    labels = load_dataset(dataset_path)
    if only:
        labels = [l for l in labels if l["id"] in only]
    rows = []
    for label in labels:
        row = freeze_one(graph, label, meta)
        rows.append(row)
        if progress:
            progress(row)
    return rows


def summary_text(rows: list[dict]) -> str:
    drafted = judged(rows)
    spent = [r["usage"]["estimated_cost_usd"] for r in rows if r.get("usage")]
    total = None if (not spent or any(c is None for c in spent)) else sum(spent)
    checks = summarize_reply_checks([{"id": r["id"], "output": {"draft_reply": r["draft"], "kb_sources": r["kb_articles"]}}
                                     for r in rows if not r.get("error")])
    lines = [f"{len(rows)} tickets, {len(drafted)} with a draft (judged), "
             f"{len(rows) - len(drafted)} without, {sum(1 for r in rows if r.get('error'))} errors"]
    for name, c in checks.items():
        lines.append(f"  {name}: {c['count']}/{c['of']}" + (f" ({', '.join(c['hits'])})" if c["hits"] else ""))
    lines.append("Measured cost of this run: " + (f"${total:.4f} (estimate)" if total is not None else "unknown"))
    return "\n".join(lines)


def main(argv=None, *, input_fn=input, graph=None, settings=None) -> int:
    parser = argparse.ArgumentParser(description="Freeze the drafts of the latest labelled dataset.")
    parser.add_argument("--dataset", default=None, help="default: the latest evals/dataset/tickets_v*.jsonl")
    parser.add_argument("--only", default=None, help="comma-separated ticket ids")
    parser.add_argument("--out", default=None, help="default: evals/judge/frozen/drafts_<today>.jsonl")
    args = parser.parse_args(argv)

    if settings is None:
        from app.config import settings
    missing = missing_keys(settings)
    if missing:
        print(f"Cannot freeze: {', '.join(missing)} not set. Set them in .env or the environment.", file=sys.stderr)
        return 1

    dataset = Path(args.dataset) if args.dataset else latest_dataset()
    out = Path(args.out) if args.out else FROZEN_DIR / f"drafts_{datetime.now():%Y-%m-%d}.jsonl"
    if out.exists():
        print(f"{out} already exists. Frozen drafts are never overwritten: pass --out to use another name.",
              file=sys.stderr)
        return 1
    only = [i.strip() for i in args.only.split(",") if i.strip()] if args.only else None
    labels = load_dataset(dataset)
    n = len([l for l in labels if not only or l["id"] in only])

    estimate = estimate_cost(n, settings.model_id)
    print(f"Dataset: {dataset} ({n} tickets)\nModel: {settings.model_id}\n"
          f"Estimated cost: {'about $%.2f' % estimate if estimate is not None else 'unknown (model has no price)'} "
          f"(up to 3 Claude calls + 1 grader call + 1 Voyage call per ticket; with VOYAGE_RPM={settings.voyage_rpm} "
          f"expect about {max(1, round(n / max(settings.voyage_rpm, 1)))} minutes)\nOutput: {out}")
    if input_fn("This makes REAL Claude and Voyage calls. Continue? [y/N] ").strip().lower() not in ("y", "yes"):
        print("Cancelled. Nothing was spent.")
        return 1

    if graph is None:
        export_credentials(settings)  # before the graph (and its Claude clients) is imported
        from langgraph.checkpoint.memory import MemorySaver

        from app.graph.build import build_triage_graph
        from app.graph.checkpointer import checkpoint_serde

        graph = build_triage_graph(MemorySaver(serde=checkpoint_serde()))

    meta = {"dataset": str(dataset), "git_commit": git_commit(),
            "models": {"drafter": settings.model_id, "classifier": settings.model_id,
                       "critic": settings.model_id, "grader": settings.model_id},
            "frozen_at": datetime.now().isoformat(timespec="seconds")}
    try:
        rows = freeze(dataset, graph, meta, only,
                      progress=lambda r: print(f"{r['id']}: {'ERROR ' + r['error'] if r['error'] else 'done'}", file=sys.stderr))
    except BillingFailed as exc:
        print(f"\nStopped: the Anthropic account has no credit left ({exc}). Add credit and run again. "
              "Nothing was written.", file=sys.stderr)
        return 1
    except AuthFailed as exc:
        print(f"\nStopped at the first ticket: the Anthropic API rejected the credentials ({exc}). "
              "Nothing was written.", file=sys.stderr)
        return 1

    drafted = judged(rows)
    if not drafted:
        errors = [r["error"] for r in rows if r.get("error")]
        why = f"{len(errors)} of {len(rows)} tickets failed; first error: {errors[0][:200]}" if errors else \
            "no ticket produced a draft"
        print(f"\nNo ticket produced a draft ({why}). Nothing was written.", file=sys.stderr)
        return 1
    write_jsonl(out, rows)
    split = make_split({r["id"]: proxy_stratum(r) for r in drafted}, SEED)
    split_file = save_split(out, split, basis="critic flag (proxy, before labelling)")
    print(f"\nWrote {out}\nWrote {split_file}: tune {len(split['tune'])}, test {len(split['test'])}\n")
    print(summary_text(rows))
    return 0


if __name__ == "__main__":
    sys.exit(main())
