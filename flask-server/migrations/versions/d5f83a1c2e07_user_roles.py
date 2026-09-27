"""user roles

``user_role`` — one row per (account, role). Backs the admin role that gates the
usage dashboard and the account list, and the annotator role that will gate
editing segmentation masks. A table rather than columns on ``user_account`` so a
third role costs no migration.

Purely additive and reversible: nothing existing is rewritten or dropped. The
table comes up empty, which means nobody is an admin until ``ADMIN_EMAILS`` is
set (granted at boot) or ``scripts/grant_role.py`` is run.

Revision ID: d5f83a1c2e07
Revises: c7e3a91f4d28
Create Date: 2026-08-12 20:14:03.117204

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd5f83a1c2e07'
down_revision: Union[str, None] = 'c7e3a91f4d28'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'user_role',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('user_id', sa.String(length=36), nullable=False),
        sa.Column('role', sa.String(length=32), nullable=False),
        # Null when the server granted it (bootstrap), or when the admin who did
        # has since been deleted.
        sa.Column('granted_by', sa.String(length=36), nullable=True),
        sa.Column('granted_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['user_account.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['granted_by'], ['user_account.id'], ondelete='SET NULL'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('user_id', 'role', name='uq_user_role_user_id_role'),
    )
    with op.batch_alter_table('user_role', schema=None) as batch_op:
        batch_op.create_index('ix_user_role_user_id', ['user_id'], unique=False)
        batch_op.create_index('ix_user_role_role', ['role'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('user_role', schema=None) as batch_op:
        batch_op.drop_index('ix_user_role_role')
        batch_op.drop_index('ix_user_role_user_id')
    op.drop_table('user_role')
