from app.kb import ingest


def test_main_applies_migrations_before_saving_any_document(monkeypatch):
    events = []
    monkeypatch.setattr(ingest, "run_migrations", lambda: events.append("migrate"))
    monkeypatch.setattr(
        ingest, "add_document", lambda topic, content: events.append(("save", topic))
    )

    ingest.main()

    assert events[0] == "migrate"
    assert events[1:] == [("save", doc["topic"]) for doc in ingest.SAMPLE_DOCS]


def test_main_saves_each_sample_document_with_its_content(monkeypatch):
    saved = []
    monkeypatch.setattr(ingest, "run_migrations", lambda: None)
    monkeypatch.setattr(
        ingest, "add_document", lambda topic, content: saved.append((topic, content))
    )

    ingest.main()

    assert saved == [(d["topic"], d["content"]) for d in ingest.SAMPLE_DOCS]


def test_main_reports_saved_not_added(monkeypatch, capsys):
    monkeypatch.setattr(ingest, "run_migrations", lambda: None)
    monkeypatch.setattr(ingest, "add_document", lambda topic, content: None)

    ingest.main()

    out = capsys.readouterr().out
    assert "saved: password reset" in out
    assert "added:" not in out
