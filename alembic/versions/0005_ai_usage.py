"""Cost per ticket: ai_usage (jsonb) and ai_cost_usd (double) on tickets.

Token usage of the model calls made for the ticket, and an ESTIMATED cost in US dollars. Both are
nullable: tickets saved before this keep NULL. Safe to run twice (IF NOT EXISTS / IF EXISTS).

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-23
"""
from typing import Sequence, Union

from alembic import op

revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ai_usage jsonb")
    op.execute("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ai_cost_usd double precision")


def downgrade() -> None:
    op.execute("ALTER TABLE tickets DROP COLUMN IF EXISTS ai_cost_usd")
    op.execute("ALTER TABLE tickets DROP COLUMN IF EXISTS ai_usage")
