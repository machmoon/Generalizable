"""accounts: users, auth_sessions, job ownership

Adds the account tables and makes every job owned (job.user_id NOT NULL + FK).
Because a job table may already hold rows from the job-store deploy (all
pre-account), we seed a reserved "system" user and backfill existing jobs to it
before enforcing NOT NULL, so the constraint can't reject legacy data.

Revision ID: 2c2b1694751f
Revises: 17c9584d5677
Create Date: 2026-07-24 02:40:32.328880
"""
from datetime import datetime, timezone
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = '2c2b1694751f'
down_revision: Union[str, None] = '17c9584d5677'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Kept as literals (not imported from models) so the migration is stable even if
# the constants in models/user.py ever change. Mirrors models.user.SYSTEM_USER_*.
SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000"
SYSTEM_USER_EMAIL = "system@bodymaps.local"


def upgrade() -> None:
    op.create_table(
        'user_account',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('email', sa.String(length=320), nullable=False),
        sa.Column('password_hash', sa.String(length=255), nullable=True),
        sa.Column('email_verified_at', sa.DateTime(), nullable=True),
        sa.Column('is_system', sa.Boolean(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('user_account', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_user_account_email'), ['email'], unique=True)

    op.create_table(
        'auth_session',
        sa.Column('id', sa.String(length=36), nullable=False),
        sa.Column('user_id', sa.String(length=36), nullable=False),
        sa.Column('token_hash', sa.String(length=64), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('expires_at', sa.DateTime(), nullable=False),
        sa.Column('revoked_at', sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(['user_id'], ['user_account.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    with op.batch_alter_table('auth_session', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_auth_session_token_hash'), ['token_hash'], unique=True)
        batch_op.create_index(batch_op.f('ix_auth_session_user_id'), ['user_id'], unique=False)

    # Seed the reserved system user (owns legacy/imported jobs).
    user_account = sa.table(
        'user_account',
        sa.column('id', sa.String), sa.column('email', sa.String),
        sa.column('password_hash', sa.String), sa.column('email_verified_at', sa.DateTime),
        sa.column('is_system', sa.Boolean), sa.column('created_at', sa.DateTime),
    )
    op.bulk_insert(user_account, [{
        'id': SYSTEM_USER_ID, 'email': SYSTEM_USER_EMAIL, 'password_hash': None,
        'email_verified_at': None, 'is_system': True,
        'created_at': datetime.now(timezone.utc).replace(tzinfo=None),
    }])

    # Add job.user_id nullable, backfill any existing jobs to the system user,
    # then enforce NOT NULL + FK + index.
    with op.batch_alter_table('job', schema=None) as batch_op:
        batch_op.add_column(sa.Column('user_id', sa.String(length=36), nullable=True))
    op.execute(
        sa.text("UPDATE job SET user_id = :sys WHERE user_id IS NULL").bindparams(sys=SYSTEM_USER_ID)
    )
    with op.batch_alter_table('job', schema=None) as batch_op:
        batch_op.alter_column('user_id', existing_type=sa.String(length=36), nullable=False)
        batch_op.create_index(batch_op.f('ix_job_user_id'), ['user_id'], unique=False)
        batch_op.create_foreign_key('fk_job_user_id', 'user_account', ['user_id'], ['id'])


def downgrade() -> None:
    with op.batch_alter_table('job', schema=None) as batch_op:
        batch_op.drop_constraint('fk_job_user_id', type_='foreignkey')
        batch_op.drop_index(batch_op.f('ix_job_user_id'))
        batch_op.drop_column('user_id')

    with op.batch_alter_table('auth_session', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_auth_session_user_id'))
        batch_op.drop_index(batch_op.f('ix_auth_session_token_hash'))
    op.drop_table('auth_session')

    with op.batch_alter_table('user_account', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_user_account_email'))
    op.drop_table('user_account')
