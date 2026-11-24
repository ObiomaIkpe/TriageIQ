"""The nightly demo reset: delete EVERY demo ticket and what hangs on it, then put the examples back.

    python -m app.demo.reset

What is deleted, and only for tickets with is_demo = true:
  - the tickets themselves (the examples AND whatever demo visitors submitted that day);
  - their LangGraph checkpoints (checkpoints, checkpoint_blobs, checkpoint_writes, keyed by thread_id = ticket id), which hold
    the ticket text of a visitor's run.
It is ONE transaction: a failure leaves the demo room exactly as it was, and a reader never sees it empty. A ticket that is not a
demo ticket, and its checkpoints, are never selected (tests/integration/test_demo_reset_pg.py proves it with real rows next to them).
Running it twice gives the same result (idempotent).

What it does NOT do, on purpose (they live in the gateway, see deploy/demo-reset.sh and deploy/README.md):
  - end the demo visitors' sessions (Redis);
  - remove the ticket references a visitor's submission reserved in the gateway database (a few bytes each, never reused, so nothing
    can collide) or the finished jobs in the queue (they hold no more than the visitor typed and expire with the queue's own clean-up).
  Delivery rows: none exist for a demo ticket (nothing is ever emailed), so there is nothing to remove.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from sqlalchemy import text

from app.db import get_session
from app.demo.seed import seed_into

CHECKPOINT_TABLES = ("checkpoint_writes", "checkpoint_blobs", "checkpoints")


def reset(now: Optional[datetime] = None) -> dict[str, int]:
    removed = {"tickets": 0, "checkpoint_rows": 0}
    with get_session() as session:
        for table in CHECKPOINT_TABLES:
            # The library creates these tables the first time the app starts; on a database where it never has, there is nothing to delete.
            if session.execute(text("SELECT to_regclass(:name)"), {"name": f"public.{table}"}).scalar() is None:
                continue
            result = session.execute(
                text(f"DELETE FROM {table} WHERE thread_id IN (SELECT id::text FROM tickets WHERE is_demo)")  # noqa: S608 (fixed table names)
            )
            removed["checkpoint_rows"] += result.rowcount or 0
        removed["tickets"] = session.execute(text("DELETE FROM tickets WHERE is_demo")).rowcount or 0
        seeded = seed_into(session, now)
    removed["seeded"] = seeded
    return removed


def main() -> None:
    result = reset()
    print(
        f"Demo reset: removed {result['tickets']} demo tickets and {result['checkpoint_rows']} checkpoint rows; "
        f"put back {result['seeded']} examples."
    )


if __name__ == "__main__":
    main()
