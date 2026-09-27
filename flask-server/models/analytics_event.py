"""Product analytics: one row per tracked interaction.

Separate from ``usage_event`` on purpose. That table is load-bearing — plan
quotas are counted off it, so it stays narrow and every row is written by the
server as part of enforcing a limit. This one is the opposite: rows arrive from
the browser in batches, nothing depends on them, and losing a batch costs a
number on a dashboard rather than a wrong quota decision.

``user_id`` is nullable because signed-out visitors are tracked too, under
``anon_id`` (a random id kept in the browser's localStorage). Every row has an
``anon_id``; only signed-in rows also have a ``user_id``.

``plan`` and ``account_type`` are SNAPSHOTS, written by the server from the
account at the time the event lands, never taken from the request body. Two
reasons: the client must not be able to claim a plan it isn't on, and a user who
moves from free to pro shouldn't retroactively rewrite what their earlier
activity is attributed to. Both are null for anonymous rows.

The same goes for the location and device columns below. ``ip_address`` is the
address the request actually arrived from, the ``country_*``/``region``/``city``
/lat/lon fields are what GeoLite2 made of it, and ``device_type`` is read off
the User-Agent header — all written by the server, none of them accepted from
the event body. A client that could name its own country would make the map
fiction.

**``ip_address`` is personal data.** It is stored in full at the site owner's
decision, it is only ever exposed through the admin-only analytics endpoints,
and it is removed with the rest of the row when ``purge_old_events`` reaches the
retention window. Location is derived at write time so that reading the map
never needs the address.
"""

from datetime import datetime

from sqlalchemy import DateTime, Float, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import db
from models.job import utcnow

# Wire values for `kind`.
KIND_ACTION = "action"      # a discrete thing the user did (clicked, ran, opened)
KIND_PAGE_VIEW = "page_view"  # a route the user was on, with how long they stayed

KINDS = frozenset({KIND_ACTION, KIND_PAGE_VIEW})


class AnalyticsEvent(db.Model):
    __tablename__ = "analytics_event"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    # CASCADE: analytics is bookkeeping, not the user's own data, so a purged
    # account takes its rows with it rather than blocking the delete. Matches
    # usage_event. Null for anonymous visitors.
    user_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("user_account.id", ondelete="CASCADE"),
        nullable=True, index=True,
    )
    # Random per-browser id. Present on every row, so "how many distinct people"
    # is answerable across signed-in and signed-out alike.
    anon_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    # Random per-tab-visit id, so a page view and the clicks inside it can be
    # tied together without needing a user.
    session_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)

    kind: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    # For an action: the curated event name ("run_inference"). For a page view:
    # the route pattern ("/case/:caseId").
    name: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    # Where it happened. Always the route pattern, never the raw URL — a case id
    # or session id in the path is user data and has no business in analytics.
    route: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # Page views carry dwell time. Null on actions.
    duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)

    # Server-written snapshots. Null for anonymous rows.
    plan: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)
    account_type: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)

    # ---- where it came from, all server-written ----
    # 45 characters: the longest an IPv6 address gets, including a v4-mapped
    # tail. Null when the request had no usable address.
    ip_address: Mapped[str | None] = mapped_column(String(45), nullable=True)
    # ISO 3166-1 alpha-2. Indexed because the map groups by it.
    country_code: Mapped[str | None] = mapped_column(String(2), nullable=True, index=True)
    country_name: Mapped[str | None] = mapped_column(String(80), nullable=True)
    # The largest subdivision GeoLite2 names — a state, province or region.
    region: Mapped[str | None] = mapped_column(String(80), nullable=True)
    city: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # The city's centroid, not the visitor's position. GeoLite2 resolves to a
    # city at best, and storing it as a point is what lets the map plot it.
    latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    # "desktop" | "mobile" | "tablet", classified from the User-Agent. Null when
    # the header is absent or says nothing useful.
    device_type: Mapped[str | None] = mapped_column(String(16), nullable=True, index=True)

    # When it happened in the browser, as reported by the client, clamped
    # server-side to a sane window. Batching means this can be a little older
    # than the moment the row was written.
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)

    __table_args__ = (
        # The dashboard's shape: a time range, narrowed by kind, grouped by name.
        Index("ix_analytics_event_created_kind", "created_at", "kind"),
        Index("ix_analytics_event_name_created", "name", "created_at"),
    )

    def __repr__(self) -> str:
        return f"<AnalyticsEvent {self.kind}:{self.name} plan={self.plan}>"
