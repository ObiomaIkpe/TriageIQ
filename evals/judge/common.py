"""Shared pieces of the judge tooling: file locations, frozen drafts, labels, sentence splitting.

A FROZEN DRAFTS file (evals/judge/frozen/drafts_<date>.jsonl) is one JSON object per line:
    id, subject, body                 the ticket as the graph received it
    kb_articles                       [{topic, content, distance}] the drafter actually received (full text)
    draft                             the reply the drafter wrote, or null when no draft was written
    judged                            true when there is a draft (tickets with no draft are kept, never judged)
    category, needs_human_review, review_reason     what the pipeline decided (NEVER shown to the labeller)
    models, git_commit, frozen_at, dataset, usage    where it came from
Next to it: drafts_<date>.split.json (the tune/test split) and, once labelled,
evals/judge/labels/drafts_<date>.labels.jsonl (one object per judged ticket: id, grounded,
unsupported_sentences, note, labelled_at).
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

JUDGE_DIR = Path(__file__).resolve().parent
FROZEN_DIR = JUDGE_DIR / "frozen"
LABELS_DIR = JUDGE_DIR / "labels"


def read_jsonl(path) -> list[dict]:
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    return [json.loads(line) for line in lines if line.strip()]


def write_text_atomic(path, text: str) -> None:
    """Write via a temporary file and a rename, so an interrupted save never leaves half a file."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def write_jsonl(path, rows: list[dict]) -> None:
    write_text_atomic(path, "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))


def load_frozen(path) -> list[dict]:
    return read_jsonl(path)


def judged(rows: list[dict]) -> list[dict]:
    """The tickets that have a draft (the only ones the judge and the labeller see)."""
    return [r for r in rows if r.get("judged") and (r.get("draft") or "").strip()]


def split_path(frozen_path) -> Path:
    p = Path(frozen_path)
    return p.with_name(p.stem + ".split.json")


def labels_path(frozen_path, labels_dir=LABELS_DIR) -> Path:
    return Path(labels_dir) / (Path(frozen_path).stem + ".labels.jsonl")


def latest_frozen(frozen_dir=FROZEN_DIR) -> Path | None:
    files = sorted(Path(frozen_dir).glob("drafts_*.jsonl"))
    return files[-1] if files else None


def load_labels(path) -> dict[str, dict]:
    """{ticket id: label}; empty when the file does not exist yet."""
    p = Path(path)
    if not p.exists():
        return {}
    return {row["id"]: row for row in read_jsonl(p)}


# A sentence ends at . ! or ? followed by whitespace; every line break also ends one (a greeting
# line, a list item and a sign-off are each their own "sentence"). Deliberately simple and
# deterministic: the labeller and the validation report must number the same pieces the same way.
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def split_sentences(text: str) -> list[str]:
    pieces: list[str] = []
    for line in (text or "").splitlines():
        line = line.strip()
        if line:
            pieces.extend(p.strip() for p in _SENTENCE_END.split(line) if p.strip())
    return pieces
