"""analytics location and device

Adds the columns behind the visitor map: the address a request arrived from, the
place GeoLite2 resolved it to, and the device class read off the User-Agent. All
written by the server at collect time — see models/analytics_event.py.

Purely additive and reversible. Every column is nullable, so existing rows keep
NULLs and simply don't appear on the map; there is no backfill, because the
addresses those events came from were never recorded and can't be recovered.

``ip_address`` holds the full address by decision of the site owner. It is
served only through the admin-only analytics endpoints and is deleted with the
rest of the row by purge_old_events() at the retention window.

Revision ID: f3a6d20c8b14
Revises: e2b7c4d91a35
Create Date: 2026-08-20 15:31:44.902117

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f3a6d20c8b14'
down_revision: Union[str, None] = 'e2b7c4d91a35'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.batch_alter_table('analytics_event', schema=None) as batch_op:
        # 45 chars: the longest an IPv6 address gets, v4-mapped tail included.
        batch_op.add_column(sa.Column('ip_address', sa.String(length=45), nullable=True))
        batch_op.add_column(sa.Column('country_code', sa.String(length=2), nullable=True))
        batch_op.add_column(sa.Column('country_name', sa.String(length=80), nullable=True))
        batch_op.add_column(sa.Column('region', sa.String(length=80), nullable=True))
        batch_op.add_column(sa.Column('city', sa.String(length=120), nullable=True))
        batch_op.add_column(sa.Column('latitude', sa.Float(), nullable=True))
        batch_op.add_column(sa.Column('longitude', sa.Float(), nullable=True))
        batch_op.add_column(sa.Column('device_type', sa.String(length=16), nullable=True))
        # The two the dashboard groups by.
        batch_op.create_index('ix_analytics_event_country_code', ['country_code'], unique=False)
        batch_op.create_index('ix_analytics_event_device_type', ['device_type'], unique=False)


def downgrade() -> None:
    with op.batch_alter_table('analytics_event', schema=None) as batch_op:
        batch_op.drop_index('ix_analytics_event_device_type')
        batch_op.drop_index('ix_analytics_event_country_code')
        batch_op.drop_column('device_type')
        batch_op.drop_column('longitude')
        batch_op.drop_column('latitude')
        batch_op.drop_column('city')
        batch_op.drop_column('region')
        batch_op.drop_column('country_name')
        batch_op.drop_column('country_code')
        batch_op.drop_column('ip_address')
