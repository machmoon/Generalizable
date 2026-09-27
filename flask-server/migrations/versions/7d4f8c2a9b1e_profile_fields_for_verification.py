"""profile fields for verification

Three nullable free-text columns on user_account: organization, occupation,
and role_description. Together with a verified email they qualify an account
for the verified-researcher tier (see services.plan_store.limits_for_user);
they gate limits only, never features, and "not provided" stays NULL.

Purely additive and reversible; no backfill — existing accounts simply have
not filled them in yet.

Revision ID: 7d4f8c2a9b1e
Revises: f3a6d20c8b14
Create Date: 2026-08-31 21:40:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '7d4f8c2a9b1e'
down_revision: Union[str, None] = 'f3a6d20c8b14'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('user_account', schema=None) as batch_op:
        batch_op.add_column(sa.Column('organization', sa.String(length=200), nullable=True))
        batch_op.add_column(sa.Column('occupation', sa.String(length=120), nullable=True))
        batch_op.add_column(sa.Column('role_description', sa.String(length=2000), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('user_account', schema=None) as batch_op:
        batch_op.drop_column('role_description')
        batch_op.drop_column('occupation')
        batch_op.drop_column('organization')
