"""user display name + deletion request

Two additive, nullable columns on user_account:

* ``name`` — the display name the user chose. Nullable because every existing
  account predates it; the client falls back to deriving one from the email.
* ``deletion_requested_at`` — non-null means the account is scheduled for
  removal. The row survives a grace period (auth_store.DELETION_GRACE_DAYS) so
  signing back in can undo it; only purge_expired_deletions drops it for good.

Both are nullable with no default and no backfill, so this is safe to run
against a live database and reversible without data loss.

Revision ID: 8a41c7f0d3b2
Revises: 1e045ac22050
Create Date: 2026-08-02 17:05:12.442918

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8a41c7f0d3b2'
down_revision: Union[str, None] = '1e045ac22050'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # batch_alter_table so SQLite (which can't ALTER ADD COLUMN with every
    # constraint) is handled the same way as Postgres.
    with op.batch_alter_table('user_account', schema=None) as batch_op:
        batch_op.add_column(sa.Column('name', sa.String(length=120), nullable=True))
        batch_op.add_column(sa.Column('deletion_requested_at', sa.DateTime(), nullable=True))


def downgrade() -> None:
    with op.batch_alter_table('user_account', schema=None) as batch_op:
        batch_op.drop_column('deletion_requested_at')
        batch_op.drop_column('name')
