"""Demo mode: tickets.is_demo.

A ticket is either REAL (the public form, API clients, real reviewers: is_demo false) or a DEMO ticket (the example
tickets shown to visitors who "try it as a reviewer", and the tickets those visitors submit). The two never mix: the
Python API answers only for the scope the gateway asks for, and the demo reset deletes only is_demo rows.

NOT NULL DEFAULT false: every existing ticket stays real. Safe to run twice (IF NOT EXISTS / IF EXISTS).

Revision ID: 0006
Revises: 0005
Create Date: 2026-11-24
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false")
    # Lists and counts always filter on it (every read has a scope).
    op.execute("CREATE INDEX IF NOT EXISTS tickets_demo_status_created_idx ON tickets (is_demo, status, created_at)")


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS tickets_demo_status_created_idx")
    op.execute("ALTER TABLE tickets DROP COLUMN IF EXISTS is_demo")
