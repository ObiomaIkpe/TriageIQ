"""Build the held-out MUTATION SET for the judge: frozen drafts with ONE planted error each.

    venv/bin/python -m evals.judge.mutate

Input : evals/judge/mutations_<date>.json (written by hand, committed) and the original frozen drafts.
Output: evals/judge/frozen/mutants_<date>.jsonl         (the drafts to judge: controls first, then mutants)
        evals/judge/labels/mutants_<date>.labels.jsonl  (every label has provenance "planted")

Each mutant changes ONE sentence of a frozen draft (op "replace") or adds ONE sentence (op "add"); the
sentence number is the number in the MUTATED draft and uses common.split_sentences, the numbering the
judge and the hand labels use. The expected label of a mutant is always "not grounded". Every source
draft in the data file's `controls` is also written unmutated (id "C-<ticket>", expected grounded).
The controls are DEV drafts: a false fail on one is not a held-out number.

No model call and no randomness: the same inputs always give byte-identical output. The build refuses
to overwrite an existing output file with different content (frozen means frozen).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from evals.judge.common import FROZEN_DIR, JUDGE_DIR, LABELS_DIR, judged, load_frozen, split_sentences

DEFAULT_DATA = JUDGE_DIR / "mutations_2026-11-24.json"
EXPECTED = "not grounded"
OPS = ("replace", "add")


class BadMutation(Exception):
    """The data file asks for something impossible or ambiguous. The message names the mutant."""


def _lines_of(draft: str) -> list[list[str]]:
    """The draft as lines of sentences, with the same pieces split_sentences produces."""
    return [split_sentences(line) for line in draft.splitlines() if line.strip()]


def _join(lines: list[list[str]]) -> str:
    return "\n".join(" ".join(pieces) for pieces in lines) + "\n"


def apply_mutation(draft: str, spec: dict) -> tuple[str, str, str | None]:
    """(mutated draft, mutated sentence, original sentence or None for an added one). Raises BadMutation."""
    who, text, n, op = spec["id"], spec["text"].strip(), spec["sentence"], spec["op"]
    if op not in OPS:
        raise BadMutation(f"{who}: op must be one of {OPS}")
    if split_sentences(text) != [text]:
        raise BadMutation(f"{who}: the new text must be exactly ONE sentence on one line")
    before = split_sentences(draft)
    lines = _lines_of(draft)
    if [p for line in lines for p in line] != before:
        raise BadMutation(f"{who}: the draft's lines do not match split_sentences")
    original = None
    if op == "replace":
        if not 1 <= n <= len(before):
            raise BadMutation(f"{who}: sentence {n} does not exist (the draft has {len(before)})")
        original = before[n - 1]
        if text == original:
            raise BadMutation(f"{who}: the replacement equals the original sentence")
        expected = before[:n - 1] + [text] + before[n:]
    else:
        if not 2 <= n <= len(before) + 1:
            raise BadMutation(f"{who}: an added sentence must have number 2..{len(before) + 1}, got {n}")
        expected = before[:n - 1] + [text] + before[n - 1:]
    seen = 0
    for line in lines:
        if op == "replace" and seen < n <= seen + len(line):
            line[n - 1 - seen] = text
            break
        if op == "add" and seen < n - 1 <= seen + len(line):
            line.insert(n - 1 - seen, text)  # in the same line as the sentence before it
            break
        seen += len(line)
    mutated = _join(lines)
    after = split_sentences(mutated)
    if after != expected:
        raise BadMutation(f"{who}: the mutated draft does not split into the expected sentences")
    if after[n - 1] != text:
        raise BadMutation(f"{who}: the new sentence is not number {n}")
    # `after == expected` already proves the draft differs from the source in exactly that sentence.
    return mutated, text, original


def build(source_rows: list[dict], data: dict) -> tuple[list[dict], list[dict]]:
    """(frozen rows, label rows): the controls first, then the mutants in the data file's order."""
    by_id = {r["id"]: r for r in judged(source_rows)}
    stamp = f"{data['date']}T00:00:00"
    frozen: list[dict] = []
    labels: list[dict] = []
    ids: set[str] = set()

    def row_from(src_id: str, new_id: str, draft: str, mutation: dict | None) -> dict:
        if src_id not in by_id:
            raise BadMutation(f"{new_id}: source ticket {src_id} is not a judged draft in the frozen file")
        row = dict(by_id[src_id])
        row.update(id=new_id, draft=draft, judged=True, source_ticket=src_id, mutation=mutation)
        return row

    for t in data["controls"]:
        cid = f"C-{t}"
        if t not in by_id:
            raise BadMutation(f"{cid}: source ticket {t} is not a judged draft in the frozen file")
        ids.add(cid)
        frozen.append(row_from(t, cid, by_id[t]["draft"], None))
        labels.append({"id": cid, "grounded": True, "unsupported_sentences": [], "provenance": "planted",
                       "note": f"control: {t} unmutated (a DEV draft, labelled grounded)", "labelled_at": stamp})
    for spec in data["mutants"]:
        if spec["id"] in ids:
            raise BadMutation(f"{spec['id']}: duplicate id")
        ids.add(spec["id"])
        if spec.get("expected") != EXPECTED:
            raise BadMutation(f"{spec['id']}: expected must be {EXPECTED!r}")
        if spec["source"] not in by_id:
            raise BadMutation(f"{spec['id']}: source ticket {spec['source']} is not a judged draft in the frozen file")
        mutated, new_sentence, original = apply_mutation(by_id[spec["source"]]["draft"], spec)
        mutation = {"source": spec["source"], "sentence": spec["sentence"], "op": spec["op"], "type": spec["type"],
                    "subtlety": spec["subtlety"], "original": original, "mutated": new_sentence, "expected": EXPECTED}
        frozen.append(row_from(spec["source"], spec["id"], mutated, mutation))
        labels.append({"id": spec["id"], "grounded": False, "unsupported_sentences": [spec["sentence"]],
                       "provenance": "planted",
                       "note": f"{spec['type']} ({spec['subtlety']}): {spec['source']} sentence {spec['sentence']}, {spec['op']}",
                       "labelled_at": stamp})
    return frozen, labels


def _dump(rows: list[dict]) -> str:
    return "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)


def write_frozen(path, text: str) -> None:
    path = Path(path)
    if path.exists() and path.read_text(encoding="utf-8") != text:
        raise BadMutation(f"{path} already exists with different content; frozen files are never overwritten")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def run(data_path=DEFAULT_DATA, source=None, out_frozen=None, out_labels=None) -> tuple[Path, Path, int, int]:
    data = json.loads(Path(data_path).read_text(encoding="utf-8"))
    source = Path(source) if source else Path(data["source_frozen"])
    if not source.is_absolute() and not source.exists():
        source = JUDGE_DIR.parent.parent / source
    out_frozen = Path(out_frozen) if out_frozen else FROZEN_DIR / f"mutants_{data['date']}.jsonl"
    out_labels = Path(out_labels) if out_labels else LABELS_DIR / f"mutants_{data['date']}.labels.jsonl"
    frozen, labels = build(load_frozen(source), data)
    write_frozen(out_frozen, _dump(frozen))
    write_frozen(out_labels, _dump(labels))
    return out_frozen, out_labels, len(data["controls"]), len(data["mutants"])


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Build the mutation set (no model calls).")
    parser.add_argument("--data", default=str(DEFAULT_DATA))
    parser.add_argument("--source", default=None, help="default: the frozen drafts named in the data file")
    parser.add_argument("--out-frozen", default=None)
    parser.add_argument("--out-labels", default=None)
    args = parser.parse_args(argv)
    try:
        fz, lb, controls, mutants = run(args.data, args.source, args.out_frozen, args.out_labels)
    except BadMutation as exc:
        print(f"Refusing: {exc}", file=sys.stderr)
        return 1
    print(f"Wrote {fz} and {lb}: {mutants} mutants (expected not grounded) + {controls} controls (expected grounded).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
