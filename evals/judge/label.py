"""Hand-labelling tool: I am the ground truth for "is this draft grounded in its articles?".

    venv/bin/python -m evals.judge.label evals/judge/frozen/drafts_<date>.jsonl

For each draft it shows the ticket, the article(s) the drafter received and the draft with numbered
sentences, then asks: grounded? (y/n); if n, which sentence numbers are unsupported, and an optional
note. It saves after EVERY answer to evals/judge/labels/<frozen name>.labels.jsonl, resumes where you
stopped, and `b` goes back one. It shows nothing the judge or the pipeline's critic said (blind).
Plain text, wrapped to 78 columns.
"""
from __future__ import annotations

import argparse
import sys
import textwrap
from datetime import datetime

from evals.judge.common import LABELS_DIR, judged, labels_path, load_frozen, load_labels, split_sentences, write_jsonl

WIDTH = 78
RULE = "=" * WIDTH


def wrap(text: str, indent: str = "") -> str:
    paragraphs = (text or "").splitlines() or [""]
    return "\n".join(textwrap.fill(p, WIDTH, initial_indent=indent, subsequent_indent=indent) for p in paragraphs)


def render(row: dict, number: int, total: int, existing: dict | None) -> str:
    parts = [RULE, f"Draft {number} of {total}   (ticket {row['id']})", RULE, "TICKET", wrap(f"Subject: {row['subject']}", "  "),
             wrap(row["body"], "  "), ""]
    if row["kb_articles"]:
        for art in row["kb_articles"]:
            parts += [f"ARTICLE the drafter received: {art['topic']}", wrap(art["content"], "  "), ""]
    else:
        parts += ["ARTICLES: none. The drafter was given no article.", ""]
    parts.append("DRAFT (numbered sentences)")
    for i, sentence in enumerate(split_sentences(row["draft"]), start=1):
        label = f"[{i}] "
        parts.append(textwrap.fill(sentence, WIDTH, initial_indent="  " + label, subsequent_indent="  " + " " * len(label)))
    parts.append("")
    if existing:
        nums = ", ".join(str(n) for n in existing["unsupported_sentences"]) or "-"
        parts.append(f"(your earlier answer: {'grounded' if existing['grounded'] else 'NOT grounded'}; "
                     f"sentences: {nums}; note: {existing.get('note') or '-'})")
    return "\n".join(parts)


def parse_numbers(text: str, count: int) -> list[int] | None:
    """'2, 5 6' -> [2, 5, 6]; None if anything is not a number in 1..count. Blank -> []."""
    nums = []
    for token in text.replace(",", " ").split():
        if not token.isdigit() or not 1 <= int(token) <= count:
            return None
        nums.append(int(token))
    return sorted(set(nums))


def run(frozen_path, labels_dir=LABELS_DIR, input_fn=input, out=print) -> int:
    rows = judged(load_frozen(frozen_path))
    if not rows:
        out("No drafts to label (no ticket in this file has a draft).")
        return 1
    path = labels_path(frozen_path, labels_dir)
    labels = load_labels(path)
    known = {r["id"] for r in rows}
    labels = {k: v for k, v in labels.items() if k in known}

    def save() -> None:
        write_jsonl(path, [labels[r["id"]] for r in rows if r["id"] in labels])

    idx = next((i for i, r in enumerate(rows) if r["id"] not in labels), len(rows))
    if idx and idx < len(rows):
        out(f"Resuming: {idx} of {len(rows)} already labelled.")
    while idx < len(rows):
        row = rows[idx]
        count = len(split_sentences(row["draft"]))
        out(render(row, idx + 1, len(rows), labels.get(row["id"])))
        try:
            answer = input_fn("Grounded in the article(s)? [y/n]  (b = back one, q = quit): ").strip().lower()
            if answer in ("q", "quit"):
                break
            if answer in ("b", "back"):
                idx = max(idx - 1, 0)
                continue
            if answer not in ("y", "n"):
                out("Please type y, n, b or q.")
                continue
            if answer == "y":
                entry = {"grounded": True, "unsupported_sentences": [], "note": ""}
            else:
                while True:
                    nums = parse_numbers(input_fn(f"Unsupported sentence numbers (1-{count}, e.g. 2,5; blank if none): "), count)
                    if nums is not None:
                        break
                    out(f"Use numbers from 1 to {count}, separated by commas or spaces.")
                entry = {"grounded": False, "unsupported_sentences": nums,
                         "note": input_fn("Note (optional): ").strip()}
        except EOFError:
            break
        labels[row["id"]] = {"id": row["id"], **entry, "labelled_at": datetime.now().isoformat(timespec="seconds")}
        save()
        idx += 1

    done = sum(1 for r in rows if r["id"] in labels)
    out(f"\n{done} of {len(rows)} labelled. Saved to {path}")
    if done == len(rows):
        out("All done. Optional next step (re-split using your labels):\n"
            f"  venv/bin/python -m evals.judge.split \\\n    {frozen_path} --by-labels")
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Label frozen drafts by hand (blind to the judge).")
    parser.add_argument("frozen")
    args = parser.parse_args(argv)
    return run(args.frozen)


if __name__ == "__main__":
    sys.exit(main())
