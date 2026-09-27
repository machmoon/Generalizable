"""email verification tokens

One-time tokens behind "verify your email address", mirroring the
password_reset_token table: hashed token, expiry, single-use ``used_at``.
Redeeming one sets user_account.email_verified_at, which (with a complete
profile) qualifies the account for the verified-researcher tier.

Purely additive and reversible.

Revision ID: 9e6a1b5d4c2f
Revises: 7d4f8c2a9b1e
Create Date: 2026-08-31 22:20:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '9e6a1b5d4c2f'
down_revision: Union[str, None] = '7d4f8c2a9b1e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'email_verification_token',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('user_id', sa.String(length=36), nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        sa.Column('used_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['user_account.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_email_verification_token_user_id', 'email_verification_token', ['user_id'])
    op.create_index('ix_email_verification_token_token_hash', 'email_verification_token', ['token_hash'], unique=True)


def downgrade() -> None:
    op.drop_index('ix_email_verification_token_token_hash', table_name='email_verification_token')
    op.drop_index('ix_email_verification_token_user_id', table_name='email_verification_token')
    op.drop_table('email_verification_token')
