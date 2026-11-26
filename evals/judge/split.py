"""A fixed, seeded tune/test split of the judged tickets.

    venv/bin/python -m evals.judge.split <frozen file> --by-labels      # re-split using my labels

The split is made when the drafts are frozen, before any labels exist, so it is stratified by a
PROXY for "not grounded" (the pipeline's own critic flagged it, or the draft is one of the known
bad shapes). After labelling, `--by-labels` redoes it stratified by the real labels (it uses my
labels only, never any judge output). Same ids + same seed + same strata = the same split.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

from evals.judge.common import judged, load_frozen, load_labels, labels_path, split_path, write_text_atomic

SEED = 20261124
TUNE_FRACTION = 0.6


def make_split(strata: dict[str, str], seed: int = SEED, tune_fraction: float = TUNE_FRACTION) -> dict:
    """{ticket id: stratum name} -> {"tune": [...], "test": [...]} (both sorted).

    Within each stratum the ids are sorted, shuffled with a seeded generator and cut at
    round(fraction * size), keeping at least one in each side when the stratum has two or more.
    """
    by_stratum: dict[str, list[str]] = {}
    for ticket_id, stratum in strata.items():
        by_stratum.setdefault(stratum, []).append(ticket_id)
    tune: list[str] = []
    test: list[str] = []
    for stratum in sorted(by_stratum):
        ids = sorted(by_stratum[stratum])
        random.Random(f"{seed}:{stratum}").shuffle(ids)
        n = len(ids)
        cut = round(tune_fraction * n)
        if n >= 2:
            cut = min(max(cut, 1), n - 1)
        tune += ids[:cut]
        test += ids[cut:]
    return {"tune": sorted(tune), "test": sorted(test)}


def proxy_stratum(row: dict) -> str:
    """Before labelling: 'suspect' if the pipeline's critic flagged the ticket, else 'clean'."""
    return "suspect" if row.get("needs_human_review") else "clean"


def save_split(frozen_path, split: dict, basis: str, seed: int = SEED) -> Path:
    path = split_path(frozen_path)
    body = {"seed": seed, "basis": basis, "tune_fraction": TUNE_FRACTION, **split}
    write_text_atomic(path, json.dumps(body, indent=2) + "\n")
    return path


def load_split(frozen_path) -> dict:
    return json.loads(split_path(frozen_path).read_text(encoding="utf-8"))


def split_from_frozen(frozen_path) -> dict:
    rows = judged(load_frozen(frozen_path))
    return make_split({r["id"]: proxy_stratum(r) for r in rows})


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Re-make the tune/test split from my labels.")
    parser.add_argument("frozen")
    parser.add_argument("--by-labels", action="store_true", required=True)
    args = parser.parse_args(argv)
    rows = judged(load_frozen(args.frozen))
    labels = load_labels(labels_path(args.frozen))
    missing = [r["id"] for r in rows if r["id"] not in labels]
    if missing:
        print(f"Cannot split by labels: not labelled yet: {', '.join(missing)}", file=sys.stderr)
        return 1
    strata = {r["id"]: ("grounded" if labels[r["id"]]["grounded"] else "not_grounded") for r in rows}
    split = make_split(strata)
    path = save_split(args.frozen, split, basis="labels")
    print(f"Wrote {path}: tune {len(split['tune'])}, test {len(split['test'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
