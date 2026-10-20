"""evals/retrieval_report.py with a fake embedder and a fake KB query: no network, no DB."""
import json
from contextlib import contextmanager

import pytest

from app.graph import classifier, critic, kb_retrieval, reply_draft
from app.kb.store import MAX_DISTANCE
from app.models import TicketIn
from evals import retrieval_report as rr

CUTOFF = 0.5


def label(ticket_id, expected, subject="subj", body="body"):
    return {"id": ticket_id, "subject": subject, "body": body, "expected_kb_topic": expected}


def analyze(expected, ranked, cutoff=CUTOFF):
    return rr.analyze_ticket(label("T", expected), ranked, cutoff)


# --- the query text and embedding match production ---

def test_query_text_is_what_retrieve_kb_context_searches_for(monkeypatch):
    seen = []
    monkeypatch.setattr(kb_retrieval, "search_similar", lambda q, top_k: seen.append(q) or [])
    kb_retrieval.retrieve_kb_context({"ticket": TicketIn(subject="Cannot log in", body="Locked out.")})
    assert seen == [rr.query_text(label("T", None, "Cannot log in", "Locked out."))]
    assert seen == ["Cannot log in Locked out."]


def test_embed_query_uses_production_embedding_with_input_type_query(monkeypatch):
    from app.kb import store
    calls = []
    monkeypatch.setattr(store, "embed_text", lambda text, input_type="document":
                        calls.append((text, input_type)) or [0.1])
    assert rr.embed_query("hello") == [0.1]
    assert calls == [("hello", "query")]


# --- ranking and the per-ticket numbers ---

RANKED = [("account lockout", 0.34), ("password reset", 0.52), ("billing cycle", 0.80)]


def test_expected_rank_and_distances_when_expected_is_first():
    r = analyze("account lockout", RANKED)
    assert [a["rank"] for a in r["articles"]] == [1, 2, 3]
    assert (r["top1_topic"], r["top1_distance"]) == ("account lockout", 0.34)
    assert (r["expected_rank"], r["expected_distance"]) == (1, 0.34)
    assert r["nearest_wrong_distance"] == 0.52
    assert r["passes_at_cutoff"] is True


def test_expected_rank_when_expected_is_not_first():
    r = analyze("billing cycle", RANKED)
    assert (r["expected_rank"], r["expected_distance"]) == (3, 0.80)
    assert r["nearest_wrong_distance"] == 0.34
    assert r["passes_at_cutoff"] is False


def test_correct_rank_one_beyond_the_cutoff_does_not_pass():
    assert analyze("account lockout", [("account lockout", 0.62), ("x", 0.9)])["passes_at_cutoff"] is False


def test_distance_exactly_at_the_cutoff_is_rejected_like_production():
    # production keeps distance < MAX_DISTANCE
    assert analyze("account lockout", [("account lockout", 0.5)])["passes_at_cutoff"] is False
    assert analyze(None, [("account lockout", 0.5)])["passes_at_cutoff"] is True


def test_null_expected_topic():
    r = analyze(None, RANKED)
    assert r["expected_rank"] is None and r["expected_distance"] is None
    assert r["nearest_wrong_distance"] == 0.34
    assert r["passes_at_cutoff"] is False  # production would retrieve something


def test_null_expected_topic_passes_when_everything_is_far():
    assert analyze(None, [("a", 0.7), ("b", 0.9)])["passes_at_cutoff"] is True


def test_expected_article_missing_from_the_kb():
    r = analyze("shipping", RANKED)
    assert r["expected_rank"] is None and r["expected_in_kb"] is False
    assert r["passes_at_cutoff"] is False


# --- summary: gap and ranking problems ---

def rows_for(spec):
    """spec: (id, expected, ranked)"""
    return [rr.analyze_ticket(label(i, e), ranked, CUTOFF) for i, e, ranked in spec]


def test_gap_exists():
    rows = rows_for([
        ("A", "t1", [("t1", 0.33), ("t2", 0.7)]),
        ("B", "t2", [("t2", 0.40), ("t1", 0.7)]),
        ("C", None, [("t1", 0.56), ("t2", 0.8)]),
        ("D", None, [("t2", 0.61), ("t1", 0.9)]),
    ])
    s = rr.summarize(rows)
    assert (s["with_topic"], s["rank1_count"]) == (2, 2)
    assert s["max_correct_rank1_distance"] == 0.40
    assert s["min_null_top1_distance"] == 0.56
    assert s["gap"]["exists"] is True
    assert (s["gap"]["low"], s["gap"]["high"]) == (0.40, 0.56)
    assert s["ranking_problems"] == []


def test_gap_does_not_exist_and_overlap_is_listed():
    rows = rows_for([
        ("A", "t1", [("t1", 0.33), ("t2", 0.7)]),
        ("B", "t2", [("t2", 0.58), ("t1", 0.7)]),
        ("C", None, [("t1", 0.45), ("t2", 0.8)]),
        ("D", None, [("t2", 0.75), ("t1", 0.9)]),
    ])
    gap = rr.summarize(rows)["gap"]
    assert gap["exists"] is False
    assert gap["overlap_correct"] == ["B"]   # correct, but not closer than the nearest null (0.45)
    assert gap["overlap_null"] == ["C"]      # null, but inside the farthest correct (0.58)


def test_touching_values_leave_no_gap():
    # a correct match at 0.5 needs c > 0.5; a null top-1 at 0.5 needs c <= 0.5
    rows = rows_for([
        ("A", "t1", [("t1", 0.5)]),
        ("C", None, [("t1", 0.5)]),
    ])
    assert rr.summarize(rows)["gap"]["exists"] is False


def test_gap_unknown_without_both_kinds_of_ticket():
    only_correct = rr.summarize(rows_for([("A", "t1", [("t1", 0.3)])]))
    only_null = rr.summarize(rows_for([("C", None, [("t1", 0.6)])]))
    assert only_correct["gap"]["exists"] is None and only_null["gap"]["exists"] is None


def test_ranking_problems_are_listed_and_excluded_from_the_gap():
    rows = rows_for([
        ("A", "t1", [("t1", 0.3), ("t2", 0.7)]),
        ("B", "t2", [("t1", 0.4), ("t2", 0.45)]),   # expected is rank 2
        ("C", "t3", [("t1", 0.4), ("t2", 0.45)]),   # expected not in KB
        ("D", None, [("t1", 0.7)]),
    ])
    s = rr.summarize(rows)
    assert s["rank1_count"] == 1 and s["with_topic"] == 3
    assert s["max_correct_rank1_distance"] == 0.3
    assert s["ranking_problems"] == [
        {"id": "B", "expected": "t2", "rank": 2, "top1": "t1"},
        {"id": "C", "expected": "t3", "rank": None, "top1": "t1"},
    ]


# --- the database query ---

class FakeSession:
    def __init__(self):
        self.statements = []

    def execute(self, statement):
        self.statements.append(str(statement.compile(compile_kwargs={"literal_binds": False})))
        return [("account lockout", 0.3), ("password reset", 0.5)]


def test_all_distances_is_one_read_only_select_with_no_limit_or_cutoff(monkeypatch):
    import app.db
    session = FakeSession()

    @contextmanager
    def fake_get_session():
        yield session

    monkeypatch.setattr(app.db, "get_session", fake_get_session)
    result = rr.all_distances([0.0] * 1024)

    assert result == [("account lockout", 0.3), ("password reset", 0.5)]
    assert session.statements[0] == "SET TRANSACTION READ ONLY"
    select = session.statements[1]
    assert select.startswith("SELECT") and "kb_documents" in select
    assert "WHERE" not in select and "LIMIT" not in select and "ORDER BY" in select
    assert len(session.statements) == 2


# --- the run ---

DATA = [
    label("R1", "account lockout", "locked", "out"),
    label("R2", None, "weather", "paris"),
    label("R3", "password reset", "boom", "x"),
]


@pytest.fixture
def dataset(tmp_path):
    path = tmp_path / "t.jsonl"
    path.write_text("\n".join(json.dumps(l) for l in DATA) + "\n", encoding="utf-8")
    return path


@pytest.fixture
def fakes(monkeypatch):
    f = type("F", (), {})()
    f.embedded = []

    def embed(text):
        f.embedded.append(text)
        if text.startswith("boom"):
            raise RuntimeError("voyage down")
        return text

    def query_all(embedding):
        if embedding.startswith("weather"):
            return [("account lockout", 0.72), ("password reset", 0.8)]
        return [("account lockout", 0.33), ("password reset", 0.6)]

    monkeypatch.setattr(rr, "embed_query", embed)
    monkeypatch.setattr(rr, "all_distances", query_all)
    return f


def test_run_embeds_each_ticket_once_with_the_production_text_in_order(fakes, dataset):
    result = rr.run_report(dataset)
    assert fakes.embedded == ["locked out", "weather paris", "boom x"]
    assert [t["id"] for t in result["tickets"]] == ["R1", "R2", "R3"]


def test_error_is_recorded_and_the_run_continues(fakes, dataset, tmp_path, capsys):
    assert rr.main(["--dataset", str(dataset), "--out", str(tmp_path / "r")]) == 0
    result = json.loads(next((tmp_path / "r").glob("retrieval-*.json")).read_text(encoding="utf-8"))
    ids = {t["id"]: t for t in result["tickets"]}
    assert ids["R3"]["error"] == "RuntimeError: voyage down"
    assert ids["R1"]["passes_at_cutoff"] is True
    assert ids["R2"]["passes_at_cutoff"] is True  # null ticket, 0.72 >= the real cutoff
    assert result["cutoff"] == MAX_DISTANCE
    assert result["summary"]["gap"]["exists"] is True


def test_writes_json_and_md_with_one_timestamp_and_prints_the_md(fakes, dataset, tmp_path, capsys):
    out = tmp_path / "r"
    rr.main(["--dataset", str(dataset), "--out", str(out)])
    (j,), (m,) = list(out.glob("*.json")), list(out.glob("*.md"))
    assert j.stem == m.stem and j.stem.startswith("retrieval-")
    md = m.read_text(encoding="utf-8")
    assert "| id | expected topic | top-1 topic |" in md
    assert "| R1 | account lockout | account lockout | 0.330 | 1 | 0.330 | 0.600 | yes |" in md
    assert "A single cutoff works." in md
    assert "R3: RuntimeError: voyage down" in md
    assert "# Retrieval distance report" in capsys.readouterr().out


def test_md_says_plainly_when_there_is_no_gap(tmp_path):
    rows = rows_for([
        ("A", "t1", [("t1", 0.58)]),
        ("C", None, [("t1", 0.45)]),
    ])
    result = {"dataset": "d", "git_commit": "x", "started_at": "now", "cutoff": 0.5,
              "summary": rr.summarize(rows), "tickets": rows}
    md = rr.render_markdown(result)
    assert "NO single cutoff works" in md
    assert "Correct matches at or beyond 0.450: A" in md
    assert "Null tickets at or inside 0.580: C" in md


def test_only_and_unknown_id(fakes, dataset, tmp_path, capsys):
    out = tmp_path / "r"
    assert rr.main(["--dataset", str(dataset), "--out", str(out), "--only", "R1"]) == 0
    result = json.loads(next(out.glob("*.json")).read_text(encoding="utf-8"))
    assert [t["id"] for t in result["tickets"]] == ["R1"]
    assert rr.main(["--dataset", str(dataset), "--out", str(tmp_path / "r2"), "--only", "R9"]) == 1
    assert "R9" in capsys.readouterr().err


def test_missing_voyage_key_exits_before_embedding(fakes, dataset, tmp_path, monkeypatch, capsys):
    from app.config import settings
    monkeypatch.setattr(settings, "voyage_api_key", "")
    assert rr.main(["--dataset", str(dataset), "--out", str(tmp_path / "r")]) == 1
    assert "VOYAGE_API_KEY" in capsys.readouterr().err
    assert fakes.embedded == []


def test_no_claude_chain_is_ever_called(fakes, dataset, tmp_path, monkeypatch):
    class Boom:
        def invoke(self, *a, **k):
            raise AssertionError("a Claude chain was called")

    for module in (classifier, reply_draft, critic):
        monkeypatch.setattr(module, "_chain", Boom())
    assert rr.main(["--dataset", str(dataset), "--out", str(tmp_path / "r")]) == 0
