"""Distance from every eval ticket to EVERY knowledge-base article, with no cutoff.

    venv/bin/python -m evals.retrieval_report

Measurement only. Makes one Voyage embedding call per ticket (through the app's own
rate limiter, retry and cache) and runs read-only SELECTs. No Claude calls, no
writes. Nothing in the app is changed or imported for its side effects.
"""
import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from evals.run_eval import DEFAULT_DATASET, DEFAULT_OUT, load_dataset


def query_text(label: dict) -> str:
    """The text production embeds for a ticket.

    A copy of the f-string in app/graph/kb_retrieval.py (retrieve_kb_context):
    subject, one space, body, no other formatting. A test pins the two together.
    """
    return f"{label['subject']} {label['body']}"


def embed_query(text: str) -> list:
    """Production's embedding path: voyage-3, input_type="query", rate limited."""
    from app.kb.store import embed_text

    return embed_text(text, input_type="query")


def all_distances(embedding: list) -> list:
    """[(topic, cosine distance)] for ALL kb rows, nearest first. SELECT only."""
    from sqlalchemy import select, text

    from app.db import get_session
    from app.kb.orm import KbDocumentRow

    distance = KbDocumentRow.embedding.cosine_distance(embedding).label("distance")
    query = select(KbDocumentRow.topic, distance).order_by(distance)
    with get_session() as session:
        # The database itself refuses writes for the rest of this transaction.
        session.execute(text("SET TRANSACTION READ ONLY"))
        return [(topic, float(dist)) for topic, dist in session.execute(query)]


def analyze_ticket(label: dict, ranked: list, cutoff: float) -> dict:
    """One ticket's result from its ranked [(topic, distance)] list."""
    expected = label.get("expected_kb_topic")
    articles = [{"rank": i, "topic": t, "distance": d} for i, (t, d) in enumerate(ranked, 1)]
    top = articles[0] if articles else None

    expected_rank = expected_distance = None
    for article in articles:
        if article["topic"] == expected:
            expected_rank, expected_distance = article["rank"], article["distance"]
    wrong = [a["distance"] for a in articles if a["topic"] != expected]

    if expected is None:
        # Nothing should come back: the nearest article has to be at or past the cutoff.
        passes = top is None or top["distance"] >= cutoff
    else:
        passes = expected_rank == 1 and top["distance"] < cutoff

    return {
        "id": label["id"],
        "expected_kb_topic": expected,
        "articles": articles,
        "top1_topic": top["topic"] if top else None,
        "top1_distance": top["distance"] if top else None,
        "expected_rank": expected_rank,
        "expected_distance": expected_distance,
        "expected_in_kb": expected is None or expected_rank is not None,
        "nearest_wrong_distance": min(wrong) if wrong else None,
        "passes_at_cutoff": passes,
    }


def summarize(rows: list) -> dict:
    """Rank-1 and null-ticket statistics, the cutoff gap, and ranking problems.

    A cutoff c, applied as production does (keep distance < c), accepts a correct
    rank-1 match when its distance is below c, and rejects a null ticket when its
    top-1 distance is at or above c. So one c serves both when
    max(correct distance) < c <= min(null top-1 distance).
    """
    with_topic = [r for r in rows if r["expected_kb_topic"] is not None]
    null_rows = [r for r in rows if r["expected_kb_topic"] is None and r["top1_distance"] is not None]
    correct = [r for r in with_topic if r["expected_rank"] == 1]

    max_correct = max((r["expected_distance"] for r in correct), default=None)
    min_null = min((r["top1_distance"] for r in null_rows), default=None)

    gap = {"exists": None, "low": max_correct, "high": min_null,
           "overlap_correct": [], "overlap_null": []}
    if max_correct is not None and min_null is not None:
        gap["exists"] = max_correct < min_null
        if not gap["exists"]:
            gap["overlap_correct"] = [r["id"] for r in correct
                                      if r["expected_distance"] >= min_null]
            gap["overlap_null"] = [r["id"] for r in null_rows
                                   if r["top1_distance"] <= max_correct]

    return {
        "with_topic": len(with_topic),
        "rank1_count": len(correct),
        "max_correct_rank1_distance": max_correct,
        "null_tickets": len(null_rows),
        "min_null_top1_distance": min_null,
        "gap": gap,
        "ranking_problems": [
            {"id": r["id"], "expected": r["expected_kb_topic"], "rank": r["expected_rank"],
             "top1": r["top1_topic"]}
            for r in with_topic if r["expected_rank"] != 1
        ],
    }


def _fmt(value) -> str:
    return "-" if value is None else f"{value:.3f}"


def render_markdown(result: dict) -> str:
    rows, summary = [r for r in result["tickets"] if not r.get("error")], result["summary"]
    cutoff = result["cutoff"]
    lines = [
        "# Retrieval distance report",
        "",
        f"- Dataset: `{result['dataset']}`",
        f"- Commit: `{result['git_commit']}`",
        f"- Started: {result['started_at']}",
        f"- Current cutoff (MAX_DISTANCE): {cutoff}",
        f"- Tickets: {len(result['tickets'])} ({len(result['tickets']) - len(rows)} errors)",
        "",
        f'"pass at {cutoff}?" means production would return the right thing: for a ticket '
        "with an expected article, that article is rank 1 and closer than the cutoff; for a "
        "null ticket, nothing is closer than the cutoff.",
        "",
        "| id | expected topic | top-1 topic | top-1 distance | expected rank "
        f"| expected distance | nearest wrong distance | pass at {cutoff}? |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r['id']} | {r['expected_kb_topic'] or 'null'} | {r['top1_topic'] or '-'} "
            f"| {_fmt(r['top1_distance'])} | {r['expected_rank'] or '-'} "
            f"| {_fmt(r['expected_distance'])} | {_fmt(r['nearest_wrong_distance'])} "
            f"| {'yes' if r['passes_at_cutoff'] else 'NO'} |"
        )

    gap = summary["gap"]
    lines += [
        "",
        "## Summary",
        "",
        f"- Tickets with an expected article: {summary['with_topic']}. "
        f"Expected article at rank 1: {summary['rank1_count']}/{summary['with_topic']}.",
        f"- Max distance among those correct rank-1 matches: "
        f"{_fmt(summary['max_correct_rank1_distance'])}",
        f"- Tickets with no expected article (null): {summary['null_tickets']}. "
        f"Min top-1 distance among them (the closest a wrong article gets): "
        f"{_fmt(summary['min_null_top1_distance'])}",
        "",
        "## Gap",
        "",
    ]
    if gap["exists"] is None:
        lines.append("Cannot tell: there are no correct rank-1 matches or no null tickets.")
    elif gap["exists"]:
        lines.append(
            f"A single cutoff works. Any value above {gap['low']:.3f} and up to "
            f"{gap['high']:.3f} accepts every correct rank-1 match and rejects every null "
            f"ticket's top-1 (distance < cutoff is kept, as in production)."
        )
    else:
        lines.append(
            f"NO single cutoff works. The farthest correct rank-1 match ({gap['low']:.3f}) is "
            f"not closer than the nearest null ticket's top-1 ({gap['high']:.3f})."
        )
        lines.append(f"- Correct matches at or beyond {gap['high']:.3f}: "
                     f"{', '.join(gap['overlap_correct']) or 'none'}")
        lines.append(f"- Null tickets at or inside {gap['low']:.3f}: "
                     f"{', '.join(gap['overlap_null']) or 'none'}")

    lines += ["", "## Expected article NOT at rank 1 (no cutoff can fix this)", ""]
    problems = summary["ranking_problems"]
    for p in problems:
        rank = p["rank"] if p["rank"] is not None else "not in the KB"
        lines.append(f"- {p['id']}: expected `{p['expected']}`, rank {rank}, "
                     f"top-1 was `{p['top1']}`")
    if not problems:
        lines.append("None.")

    errors = [t for t in result["tickets"] if t.get("error")]
    lines += ["", "## Errors", ""]
    lines += [f"- {t['id']}: {t['error']}" for t in errors] or ["None."]
    return "\n".join(lines) + "\n"


def run_report(dataset_path, only=None, embed=None, query_all=None) -> dict:
    """Embed each ticket once, rank every article, analyse. embed/query_all are injectable."""
    embed = embed or embed_query
    query_all = query_all or all_distances
    from app.kb.store import MAX_DISTANCE
    from evals.run_eval import git_commit

    labels = load_dataset(dataset_path)
    if only:
        known = {label["id"] for label in labels}
        unknown = [i for i in only if i not in known]
        if unknown:
            raise ValueError(f"Unknown ticket id(s) in --only: {', '.join(unknown)}")
        labels = [label for label in labels if label["id"] in only]

    started_at = datetime.now()
    tickets = []
    for label in labels:
        try:
            ranked = query_all(embed(query_text(label)))
            tickets.append(analyze_ticket(label, ranked, MAX_DISTANCE))
        except Exception as exc:  # one failed ticket must not stop the report
            tickets.append({"id": label["id"], "error": f"{type(exc).__name__}: {exc}"})
        print(f"{label['id']}: {'ERROR' if tickets[-1].get('error') else 'done'}", file=sys.stderr)

    ok = [t for t in tickets if not t.get("error")]
    return {
        "dataset": str(dataset_path),
        "git_commit": git_commit(),
        "started_at": started_at.isoformat(timespec="seconds"),
        "cutoff": MAX_DISTANCE,
        "summary": summarize(ok),
        "tickets": tickets,
    }


def write_reports(result: dict, out_dir) -> tuple:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    json_path, md_path = out / f"retrieval-{stamp}.json", out / f"retrieval-{stamp}.md"
    json_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    md_path.write_text(render_markdown(result), encoding="utf-8")
    return json_path, md_path


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Distance from each eval ticket to every KB article.")
    parser.add_argument("--dataset", default=DEFAULT_DATASET)
    parser.add_argument("--only", default=None, help="comma-separated ticket ids, e.g. T01,T05")
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args(argv)

    from app.config import settings

    if not (settings.voyage_api_key or "").strip():
        print("Cannot run the report: VOYAGE_API_KEY not set. Set it in .env or the environment.",
              file=sys.stderr)
        return 1

    only = [i.strip() for i in args.only.split(",") if i.strip()] if args.only else None
    try:
        result = run_report(args.dataset, only)
    except (ValueError, OSError) as exc:
        print(f"Cannot run the report: {exc}", file=sys.stderr)
        return 1

    json_path, md_path = write_reports(result, args.out)
    print(md_path.read_text(encoding="utf-8"))
    print(f"Wrote {json_path} and {md_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
