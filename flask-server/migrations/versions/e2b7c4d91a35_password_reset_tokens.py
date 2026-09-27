"""password reset tokens

``password_reset_token`` — one row per "I forgot my password" request. Backs the
reset link emailed to the user: only the token's SHA-256 is stored, the row is
single-use via ``used_at``, and it expires in an hour.

Purely additive and reversible: nothing existing is rewritten or dropped. The
table comes up empty, and until someone asks for a reset it stays that way.

Revision ID: e2b7c4d91a35
Revises: d5f83a1c2e07
Create Date: 2026-08-20 14:02:11.480913

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e2b7c4d91a35'
down_revision: Union[str, None] = 'd5f83a1c2e07'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'password_reset_token',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('user_id', sa.String(length=36), nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        # Null while redeemable; set on use, or when a newer request supersedes it.
        sa.Column('used_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['user_account.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('password_reset_token', schema=None) as batch_op:
        batch_op.create_index('ix_password_reset_token_user_id', ['user_id'], unique=False)
        batch_op.create_index('ix_password_reset_token_token_hash', ['token_hash'], unique=True)


def downgrade() -> None:
    with op.batch_alter_table('password_reset_token', schema=None) as batch_op:
        batch_op.drop_index('ix_password_reset_token_token_hash')
        batch_op.drop_index('ix_password_reset_token_user_id')
    op.drop_table('password_reset_token')
