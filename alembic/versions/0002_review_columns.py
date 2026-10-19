"""Review columns on tickets: reference, final_reply, review_note, reviewed_at.

Every existing row gets a unique reference. The column is added as nullable, filled
row by row, and only then made NOT NULL and UNIQUE.

tickets.status is plain text (no enum, no CHECK), so the new status values
(approved, edited, rejected) need no change here.

The reference generator below is a copy on purpose: a migration must not change
when app code changes, and it must not import app code.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-19
"""
import secrets
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0, O, 1, I or L


def _new_reference() -> str:
    return "TKT-" + "".join(secrets.choice(_ALPHABET) for _ in range(6))


def upgrade() -> None:
    op.add_column("tickets", sa.Column("reference", sa.Text(), nullable=True))
    op.add_column("tickets", sa.Column("final_reply", sa.Text(), nullable=True))
    op.add_column("tickets", sa.Column("review_note", sa.Text(), nullable=True))
    op.add_column(
        "tickets", sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True)
    )

    conn = op.get_bind()
    ids = conn.execute(sa.text("SELECT id FROM tickets ORDER BY created_at, id")).scalars().all()
    used: set[str] = set()
    for ticket_id in ids:
        reference = _new_reference()
        while reference in used:  # a duplicate: draw again
            reference = _new_reference()
        used.add(reference)
        conn.execute(
            sa.text("UPDATE tickets SET reference = :reference WHERE id = :id"),
            {"reference": reference, "id": ticket_id},
        )

    op.alter_column("tickets", "reference", nullable=False)
    op.create_unique_constraint("tickets_reference_key", "tickets", ["reference"])


def downgrade() -> None:
    op.drop_constraint("tickets_reference_key", "tickets", type_="unique")
    op.drop_column("tickets", "reviewed_at")
    op.drop_column("tickets", "review_note")
    op.drop_column("tickets", "final_reply")
    op.drop_column("tickets", "reference")
