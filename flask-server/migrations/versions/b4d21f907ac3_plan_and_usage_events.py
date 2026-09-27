"""account plan + usage events

Two things, both additive:

* ``user_account.plan`` — the billing plan id. NOT NULL with a server default of
  'free', so every existing row is backfilled by the default itself and no
  separate UPDATE is needed.
* ``usage_event`` — one row per metered action (an inference run, an assistant
  message). Backs the plan quotas in services/plan_store.py. Deliberately not a
  count over ``job``: the frontend's /run-inference path never writes a job row.

Safe against a live database (nothing is rewritten or dropped) and reversible.

Revision ID: b4d21f907ac3
Revises: 8a41c7f0d3b2
Create Date: 2026-08-07 10:12:04.118273

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b4d21f907ac3'
down_revision: Union[str, None] = '8a41c7f0d3b2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('user_account', schema=None) as batch_op:
        batch_op.add_column(sa.Column(
            'plan', sa.String(length=16), nullable=False, server_default='free'
        ))

    op.create_table(
        'usage_event',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('user_id', sa.String(length=36), nullable=False),
        sa.Column('kind', sa.String(length=24), nullable=False),
        sa.Column('ref_id', sa.String(length=128), nullable=True),
        sa.Column('model', sa.String(length=64), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('finished_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['user_account.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('usage_event', schema=None) as batch_op:
        batch_op.create_index('ix_usage_event_user_id', ['user_id'], unique=False)
        batch_op.create_index('ix_usage_event_ref_id', ['ref_id'], unique=False)
        batch_op.create_index(
            'ix_usage_event_user_kind_created', ['user_id', 'kind', 'created_at'], unique=False
        )


def downgrade() -> None:
    with op.batch_alter_table('usage_event', schema=None) as batch_op:
        batch_op.drop_index('ix_usage_event_user_kind_created')
        batch_op.drop_index('ix_usage_event_ref_id')
        batch_op.drop_index('ix_usage_event_user_id')
    op.drop_table('usage_event')

    with op.batch_alter_table('user_account', schema=None) as batch_op:
        batch_op.drop_column('plan')
