"""Initial schema: the knowledge base and tickets tables.

Safe on a database that already has these tables from the old raw-SQL setup:
tables and indexes are created only if missing, and duplicate topics are removed
(keeping the lowest id) before the unique topic index is built.

Revision ID: 0001
Revises:
Create Date: 2026-10-06
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from pgvector.sqlalchemy import Vector
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

EMBEDDING_DIM = 1024  # voyage-3 output dimension; fixed for this revision


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    op.create_table(
        "kb_documents",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("topic", sa.Text(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("embedding", Vector(EMBEDDING_DIM), nullable=False),
        if_not_exists=True,
    )
    # A database created before topics were unique may hold duplicates.
    op.execute(
        "DELETE FROM kb_documents a USING kb_documents b "
        "WHERE a.topic = b.topic AND a.id > b.id"
    )
    op.create_index(
        "kb_documents_topic_key",
        "kb_documents",
        ["topic"],
        unique=True,
        if_not_exists=True,
    )

    op.create_table(
        "tickets",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("subject", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("customer_id", sa.Text()),
        sa.Column("category", sa.Text(), nullable=False),
        sa.Column("urgency", sa.Text(), nullable=False),
        sa.Column("confidence", sa.Double(), nullable=False),
        sa.Column("routing_target", sa.Text(), nullable=False),
        sa.Column("suggested_reply", sa.Text()),
        sa.Column(
            "kb_sources",
            postgresql.JSONB(),
            nullable=False,
            server_default=sa.text("'[]'::jsonb"),
        ),
        sa.Column("needs_human_review", sa.Boolean(), nullable=False),
        sa.Column("review_reason", sa.Text()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        if_not_exists=True,
    )
    op.create_index(
        "tickets_status_created_idx",
        "tickets",
        ["status", "created_at"],
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index("tickets_status_created_idx", table_name="tickets")
    op.drop_table("tickets")
    op.drop_index("kb_documents_topic_key", table_name="kb_documents")
    op.drop_table("kb_documents")
