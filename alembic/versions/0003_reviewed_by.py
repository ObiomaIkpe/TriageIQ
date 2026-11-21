"""Who reviewed a ticket: reviewed_by_id and reviewed_by_name on tickets.

Two nullable columns, written together with the review decision. Rows reviewed before this
migration keep NULL in both (the author was never recorded). The name is a snapshot taken at
review time. A CHECK keeps the pair together: both set or both NULL.

Written to be safe to run twice (IF NOT EXISTS / IF EXISTS), as the startup does not guard against
a partly applied earlier attempt.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-21
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0003"
down_revision: Union[str, None] = "0002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reviewed_by_id text")
    op.execute("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS reviewed_by_name text")
    op.execute("ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_reviewed_by_both_or_neither")
    op.execute(
        "ALTER TABLE tickets ADD CONSTRAINT tickets_reviewed_by_both_or_neither "
        "CHECK ((reviewed_by_id IS NULL) = (reviewed_by_name IS NULL))"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_reviewed_by_both_or_neither")
    op.execute("ALTER TABLE tickets DROP COLUMN IF EXISTS reviewed_by_name")
    op.execute("ALTER TABLE tickets DROP COLUMN IF EXISTS reviewed_by_id")
