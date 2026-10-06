"""The Postgres checkpointer against a real database.

A trivial compiled graph runs under a thread_id; the checkpoint rows must exist.
"""
import uuid
from typing import TypedDict

import pytest
from langgraph.graph import END, StateGraph

from app.graph.checkpointer import create_checkpointer

pytestmark = pytest.mark.integration


class State(TypedDict, total=False):
    n: int


def bump(state):
    return {"n": state.get("n", 0) + 1}


def build(saver):
    graph = StateGraph(State)
    graph.add_node("bump", bump)
    graph.set_entry_point("bump")
    graph.add_edge("bump", END)
    return graph.compile(checkpointer=saver)


def _rows(checkpointer, table, thread_id):
    with checkpointer.pool.connection() as conn:
        return conn.execute(
            f"SELECT count(*) AS c FROM {table} WHERE thread_id = %s", (thread_id,)
        ).fetchone()["c"]


@pytest.fixture
def checkpointer(clean_database):
    cp = create_checkpointer(clean_database)
    yield cp
    cp.close()


def test_setup_creates_the_librarys_tables(checkpointer):
    with checkpointer.pool.connection() as conn:
        tables = {
            row["tablename"]
            for row in conn.execute(
                "SELECT tablename FROM pg_tables WHERE tablename LIKE 'checkpoint%'"
            ).fetchall()
        }

    assert {"checkpoints", "checkpoint_blobs", "checkpoint_writes"} <= tables


def test_a_run_with_a_thread_id_writes_checkpoint_rows_for_that_thread(checkpointer):
    graph = build(checkpointer.saver)
    thread_id = str(uuid.uuid4())

    result = graph.invoke({"n": 0}, config={"configurable": {"thread_id": thread_id}})

    assert result == {"n": 1}
    assert _rows(checkpointer, "checkpoints", thread_id) >= 1


def test_the_saved_state_can_be_read_back_for_the_thread(checkpointer):
    graph = build(checkpointer.saver)
    thread_id = str(uuid.uuid4())
    config = {"configurable": {"thread_id": thread_id}}

    graph.invoke({"n": 41}, config=config)

    assert graph.get_state(config).values == {"n": 42}


def test_different_threads_do_not_share_state(checkpointer):
    graph = build(checkpointer.saver)
    first, second = str(uuid.uuid4()), str(uuid.uuid4())

    graph.invoke({"n": 1}, config={"configurable": {"thread_id": first}})
    graph.invoke({"n": 10}, config={"configurable": {"thread_id": second}})

    assert graph.get_state({"configurable": {"thread_id": first}}).values == {"n": 2}
    assert graph.get_state({"configurable": {"thread_id": second}}).values == {"n": 11}
    assert _rows(checkpointer, "checkpoints", first) >= 1
    assert _rows(checkpointer, "checkpoints", second) >= 1


def test_creating_a_checkpointer_twice_is_safe(clean_database):
    first = create_checkpointer(clean_database)
    second = create_checkpointer(clean_database)  # setup() again on existing tables

    first.close()
    second.close()


def test_an_unreachable_database_fails_instead_of_hanging(monkeypatch):
    from app.graph import checkpointer as module

    monkeypatch.setattr(module, "POOL_OPEN_TIMEOUT_SECONDS", 1.0)

    with pytest.raises(Exception):
        module.create_checkpointer("postgresql://u:p@127.0.0.1:1/nothing_test")
