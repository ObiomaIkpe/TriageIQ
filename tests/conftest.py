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
    from app.main import app

    graph = build_triage_graph(MemorySaver())
    app.dependency_overrides[get_graph] = lambda: graph
    yield graph
    app.dependency_overrides.pop(get_graph, None)