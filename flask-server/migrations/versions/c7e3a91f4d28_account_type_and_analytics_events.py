"""account type + product analytics events

Two things, both additive:

* ``user_account.account_type`` — the self-reported patient/clinician/
  researcher/student value. It used to live in the browser's localStorage and
  gate nothing, which meant the server had never seen it and analytics could not
  be sliced by it. Nullable: existing accounts genuinely have no answer, and
  "not set" is a real category rather than a value to invent.
* ``analytics_event`` — one row per tracked interaction, written from the
  browser in batches. Kept apart from ``usage_event`` because that table backs
  plan quotas; this one backs a dashboard.

Safe against a live database (nothing is rewritten or dropped) and reversible.

Revision ID: c7e3a91f4d28
Revises: b4d21f907ac3
Create Date: 2026-08-08 12:04:11.882170

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c7e3a91f4d28'
down_revision: Union[str, None] = 'b4d21f907ac3'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('user_account', schema=None) as batch_op:
        batch_op.add_column(sa.Column('account_type', sa.String(length=16), nullable=True))

    op.create_table(
        'analytics_event',
        sa.Column('id', sa.String(length=36), nullable=False),
        # Nullable: signed-out visitors are tracked under anon_id alone.
        sa.Column('user_id', sa.String(length=36), nullable=True),
        sa.Column('anon_id', sa.String(length=64), nullable=False),
        sa.Column('session_id', sa.String(length=64), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('name', sa.String(length=64), nullable=False),
        sa.Column('route', sa.String(length=120), nullable=True),
        sa.Column('duration_ms', sa.Integer(), nullable=True),
        sa.Column('plan', sa.String(length=16), nullable=True),
        sa.Column('account_type', sa.String(length=16), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['user_account.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('analytics_event', schema=None) as batch_op:
        batch_op.create_index('ix_analytics_event_user_id', ['user_id'], unique=False)
        batch_op.create_index('ix_analytics_event_anon_id', ['anon_id'], unique=False)
        batch_op.create_index('ix_analytics_event_session_id', ['session_id'], unique=False)
        batch_op.create_index('ix_analytics_event_kind', ['kind'], unique=False)
        batch_op.create_index('ix_analytics_event_name', ['name'], unique=False)
        batch_op.create_index('ix_analytics_event_plan', ['plan'], unique=False)
        batch_op.create_index('ix_analytics_event_account_type', ['account_type'], unique=False)
        batch_op.create_index(
            'ix_analytics_event_created_kind', ['created_at', 'kind'], unique=False
        )
        batch_op.create_index(
            'ix_analytics_event_name_created', ['name', 'created_at'], unique=False
        )


def downgrade() -> None:
    with op.batch_alter_table('analytics_event', schema=None) as batch_op:
        batch_op.drop_index('ix_analytics_event_name_created')
        batch_op.drop_index('ix_analytics_event_created_kind')
        batch_op.drop_index('ix_analytics_event_account_type')
        batch_op.drop_index('ix_analytics_event_plan')
        batch_op.drop_index('ix_analytics_event_name')
        batch_op.drop_index('ix_analytics_event_kind')
        batch_op.drop_index('ix_analytics_event_session_id')
        batch_op.drop_index('ix_analytics_event_anon_id')
        batch_op.drop_index('ix_analytics_event_user_id')
    op.drop_table('analytics_event')

    with op.batch_alter_table('user_account', schema=None) as batch_op:
        batch_op.drop_column('account_type')
