"""Who wrote in: customer_name and customer_email on tickets (public form).

Two nullable text columns. Existing rows, and every ticket that comes in through an API client,
keep NULL. They are stored and shown to reviewers; they are never given to the model.

Written to be safe to run twice (IF NOT EXISTS / IF EXISTS), like 0003.

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-22
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0004"
down_revision: Union[str, None] = "0003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS customer_name text")
    op.execute("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS customer_email text")


def downgrade() -> None:
    op.execute("ALTER TABLE tickets DROP COLUMN IF EXISTS customer_email")
    op.execute("ALTER TABLE tickets DROP COLUMN IF EXISTS customer_name")
