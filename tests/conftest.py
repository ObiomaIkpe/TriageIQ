import os

import pytest

# Set dummy keys before any app module is imported, so importing the graph
# modules never needs real credentials and tests never hit the network.
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key")
os.environ.setdefault("VOYAGE_API_KEY", "test-key")


@pytest.fixture(autouse=True)
def triage_graph_override():
    """Give every test an in-memory graph, so none of them needs Postgres.

    The app builds its real graph, with a Postgres checkpointer, at startup. The
    tests do not run that startup, so they swap the get_graph dependency for a
    graph built with a MemorySaver. The override is removed after each test.
    Yields the graph, for tests that want to inspect its saved state.
    """
    from langgraph.checkpoint.memory import MemorySaver

    from app.api.deps import get_graph
    from app.graph.build import build_triage_graph
    from app.graph.checkpointer import checkpoint_serde
    from app.main import app

    # Same serializer as production, so a state type missing from the allowlist
    # shows up as a failing test here and not as a surprise on resume.
    graph = build_triage_graph(MemorySaver(serde=checkpoint_serde()))
    app.dependency_overrides[get_graph] = lambda: graph
    yield graph
    app.dependency_overrides.pop(get_graph, None)

@pytest.fixture(autouse=True)
def kb_grader_keeps_everything(monkeypatch):
    """By default the KB grader (a Claude call) keeps every retrieved article.

    Tests that care about grading replace kb_grader._chain themselves. Without this
    fake, any test that runs the graph with a KB match would call the real model.
    """
    import re

    from app.graph import kb_grader

    class KeepAll:
        def invoke(self, inputs):
            topics = re.findall(r"ARTICLE START \(topic: (.*)\)", inputs["articles"])
            return kb_grader.KbGradeResult(relevant_topics=topics, reason="Relevant.")

    monkeypatch.setattr(kb_grader, "_chain", KeepAll())
