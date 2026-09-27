"""Unit tests for the analytics store: what it accepts, what it refuses, and
whether the aggregates the dashboard reads are actually right.

Each test gets its own temp-file database, following test_plan_store's fixture.
"""

import importlib
from datetime import timedelta

import pytest

from models.job import utcnow


@pytest.fixture()
def store(tmp_path, monkeypatch):
    """Fresh temp DB; hands back (analytics_store, auth_store, user_id)."""
    db_path = tmp_path / "analytics.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_path}")

    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.job  # noqa: F401
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.usage_event  # noqa: F401
    import models.analytics_event  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import services.analytics_store as analytics_store
    importlib.reload(analytics_store)

    engine.reset_engine_for_tests()
    engine.create_all()
    user = auth_store.create_user("tracked@example.com", "correct-horse-battery")
    yield analytics_store, auth_store, user["id"]
    engine.reset_engine_for_tests()


def action(name, **extra):
    base = {"kind": "action", "name": name, "anon_id": "anon-1", "session_id": "sess-1"}
    base.update(extra)
    return base


def page(name, duration_ms, **extra):
    base = {
        "kind": "page_view", "name": name, "route": name,
        "duration_ms": duration_ms, "anon_id": "anon-1", "session_id": "sess-1",
    }
    base.update(extra)
    return base


def wide_range():
    now = utcnow()
    return now - timedelta(days=1), now + timedelta(days=1)


# ---- recording -------------------------------------------------------------

def test_records_a_batch_and_reports_how_many_landed(store):
    analytics_store, _, user_id = store
    stored = analytics_store.record_events(
        [action("upload_start_inference"), page("/upload", 5000)], user_id=user_id
    )
    assert stored == 2


def test_unknown_event_names_are_dropped_without_failing_the_batch(store):
    analytics_store, _, user_id = store
    stored = analytics_store.record_events([
        action("upload_start_inference"),
        action("something_someone_made_up"),
        {"kind": "action", "name": "viewer_open_case"},  # no anon/session id
    ], user_id=user_id)
    assert stored == 1


def test_a_route_outside_the_pattern_list_is_not_stored(store):
    """A raw URL carrying a case id must never become a row."""
    analytics_store, _, user_id = store
    assert analytics_store.record_events(
        [page("/case/BDMAP_00000123", 1000)], user_id=user_id
    ) == 0


def test_plan_and_type_are_taken_from_the_account_not_the_request(store):
    analytics_store, auth_store, user_id = store
    auth_store.update_account_type(user_id, "clinician")

    analytics_store.record_events(
        [action("viewer_open_case", plan="enterprise", account_type="patient")],
        user_id=user_id,
    )

    data = analytics_store.overview(*wide_range())
    assert data["by_plan"] == [{"plan": "free", "events": 1, "people": 1}]
    assert data["by_account_type"] == [
        {"account_type": "clinician", "events": 1, "people": 1}
    ]


def test_anonymous_events_are_stored_with_no_account(store):
    analytics_store, _, _ = store
    assert analytics_store.record_events([action("auth_open_modal")], user_id=None) == 1

    data = analytics_store.overview(*wide_range())
    assert data["totals"]["people"] == 1
    assert data["totals"]["signed_in_people"] == 0
    assert data["by_plan"] == [{"plan": "anonymous", "events": 1, "people": 1}]


def test_a_signed_in_user_without_a_type_is_not_counted_as_anonymous(store):
    analytics_store, _, user_id = store
    analytics_store.record_events([action("viewer_open_case")], user_id=user_id)
    analytics_store.record_events(
        [action("auth_open_modal", anon_id="anon-2", session_id="sess-2")], user_id=None
    )

    labels = {r["account_type"] for r in analytics_store.overview(*wide_range())["by_account_type"]}
    assert labels == {"not set", "anonymous"}


def test_a_future_timestamp_is_clamped_to_now(store):
    analytics_store, _, user_id = store
    year_3000 = 32503680000000
    analytics_store.record_events(
        [action("viewer_open_case", ts=year_3000)], user_id=user_id
    )
    # Still inside a range that ends tomorrow, so it was not stored in the future.
    assert analytics_store.overview(*wide_range())["totals"]["events"] == 1


def test_an_absurd_page_duration_is_clamped_rather_than_dropped(store):
    analytics_store, _, user_id = store
    a_week_ms = 7 * 24 * 60 * 60 * 1000
    analytics_store.record_events([page("/dashboard", a_week_ms)], user_id=user_id)

    route = analytics_store.overview(*wide_range())["time_by_route"][0]
    assert route["views"] == 1
    assert route["total_ms"] == analytics_store.MAX_DURATION_MS


def test_an_oversized_batch_is_truncated(store):
    analytics_store, _, user_id = store
    events = [action("viewer_open_case")] * (analytics_store.MAX_BATCH + 50)
    assert analytics_store.record_events(events, user_id=user_id) == analytics_store.MAX_BATCH


def test_empty_and_malformed_batches_are_a_no_op(store):
    analytics_store, _, user_id = store
    assert analytics_store.record_events([], user_id=user_id) == 0
    assert analytics_store.record_events(None, user_id=user_id) == 0
    assert analytics_store.record_events(["not a dict"], user_id=user_id) == 0


# ---- dedup -----------------------------------------------------------------
#
# The case these exist for: the browser flushes on pagehide with keepalive, the
# request is retried, and the identical body arrives twice.

def test_a_replayed_batch_is_stored_once(store):
    analytics_store, _, user_id = store
    batch = [
        action("upload_start_inference", id="evt-1"),
        page("/upload", 5000, id="evt-2"),
    ]

    assert analytics_store.record_events(batch, user_id=user_id) == 2
    assert analytics_store.record_events(batch, user_id=user_id) == 0

    assert analytics_store.overview(*wide_range())["totals"]["events"] == 2


def test_a_partly_replayed_batch_stores_only_what_is_new(store):
    """A retry that also carries events queued since the first attempt."""
    analytics_store, _, user_id = store
    analytics_store.record_events([action("viewer_open_case", id="evt-1")], user_id=user_id)

    stored = analytics_store.record_events([
        action("viewer_open_case", id="evt-1"),
        action("viewer_measure", id="evt-2"),
    ], user_id=user_id)

    assert stored == 1
    assert analytics_store.overview(*wide_range())["totals"]["events"] == 2


def test_an_id_repeated_inside_one_batch_does_not_fail_the_batch(store):
    analytics_store, _, user_id = store
    stored = analytics_store.record_events([
        action("viewer_open_case", id="same"),
        action("viewer_measure", id="same"),
        action("report_open", id="other"),
    ], user_id=user_id)
    assert stored == 2


def test_events_without_an_id_are_still_stored(store):
    """A tab running a cached older build sends no id; it must not be dropped,
    and two of its events must not collapse into one."""
    analytics_store, _, user_id = store
    assert analytics_store.record_events(
        [action("viewer_open_case"), action("viewer_open_case")], user_id=user_id
    ) == 2


def test_an_unusable_id_is_replaced_rather_than_refused(store):
    analytics_store, _, user_id = store
    stored = analytics_store.record_events([
        action("viewer_open_case", id=""),
        action("viewer_measure", id=12345),
        action("report_open", id="x" * 200),
    ], user_id=user_id)
    assert stored == 3


# ---- retention -------------------------------------------------------------

def test_purge_drops_events_past_the_window_and_keeps_the_rest(store):
    analytics_store, _, user_id = store
    now = utcnow()
    old = (now - timedelta(days=500)).timestamp() * 1000
    recent = (now - timedelta(days=5)).timestamp() * 1000

    # MAX_AGE clamps anything the client claims is older than 48h, so the aged
    # row has to be written and then backdated in place.
    analytics_store.record_events([
        action("viewer_open_case", id="old", ts=old),
        action("viewer_measure", id="recent", ts=recent),
    ], user_id=user_id)
    _backdate(analytics_store, "old", now - timedelta(days=500))

    assert analytics_store.purge_old_events() == 1

    remaining = analytics_store.overview(
        now - timedelta(days=1000), now + timedelta(days=1)
    )
    assert [r["name"] for r in remaining["top_actions"]] == ["viewer_measure"]


def test_purge_is_a_no_op_when_nothing_is_old_enough(store):
    analytics_store, _, user_id = store
    analytics_store.record_events([action("viewer_open_case")], user_id=user_id)
    assert analytics_store.purge_old_events() == 0


def test_retention_window_is_configurable_and_floored(store, monkeypatch):
    analytics_store, _, _ = store
    assert analytics_store.retention_days() == analytics_store.DEFAULT_RETENTION_DAYS

    # A stricter window is a policy choice and is honoured as given.
    monkeypatch.setenv("ANALYTICS_RETENTION_DAYS", "90")
    assert analytics_store.retention_days() == 90
    monkeypatch.setenv("ANALYTICS_RETENTION_DAYS", "7")
    assert analytics_store.retention_days() == 7

    # A value that can't have been meant falls back rather than emptying the
    # table on the next boot.
    for unusable in ("0", "-30", "soon", "30.5"):
        monkeypatch.setenv("ANALYTICS_RETENTION_DAYS", unusable)
        assert analytics_store.retention_days() == analytics_store.DEFAULT_RETENTION_DAYS


def _backdate(analytics_store, event_id, when):
    """Move a stored row's created_at, to age it past the retention window."""
    from models.analytics_event import AnalyticsEvent
    from models.engine import session_scope
    with session_scope() as s:
        s.get(AnalyticsEvent, event_id).created_at = when


# ---- aggregates ------------------------------------------------------------

def test_top_actions_are_ordered_by_how_often_they_happened(store):
    analytics_store, _, user_id = store
    analytics_store.record_events(
        [action("viewer_open_case")] * 3 + [action("report_open")] * 5, user_id=user_id
    )

    top = analytics_store.overview(*wide_range())["top_actions"]
    assert [t["name"] for t in top] == ["report_open", "viewer_open_case"]
    assert top[0]["count"] == 5


def test_time_by_route_sums_and_averages_dwell_time(store):
    analytics_store, _, user_id = store
    analytics_store.record_events(
        [page("/dashboard", 1000), page("/dashboard", 3000), page("/upload", 500)],
        user_id=user_id,
    )

    data = analytics_store.overview(*wide_range())
    dashboard = next(r for r in data["time_by_route"] if r["route"] == "/dashboard")
    assert dashboard["views"] == 2
    assert dashboard["total_ms"] == 4000
    assert dashboard["avg_ms"] == 2000
    assert data["totals"]["time_ms"] == 4500


def test_filtering_by_plan_excludes_everyone_else(store):
    analytics_store, auth_store, user_id = store
    other = auth_store.create_user("pro@example.com", "correct-horse-battery")
    import services.plan_store as plan_store
    plan_store.set_plan(other["id"], "pro")

    analytics_store.record_events([action("viewer_open_case")], user_id=user_id)
    analytics_store.record_events(
        [action("report_open", anon_id="anon-2", session_id="sess-2")], user_id=other["id"]
    )

    start, end = wide_range()
    pro_only = analytics_store.overview(start, end, plan="pro")
    assert pro_only["totals"]["events"] == 1
    assert [t["name"] for t in pro_only["top_actions"]] == ["report_open"]


def test_filtering_by_account_type_excludes_everyone_else(store):
    analytics_store, auth_store, user_id = store
    auth_store.update_account_type(user_id, "researcher")
    other = auth_store.create_user("student@example.com", "correct-horse-battery")
    auth_store.update_account_type(other["id"], "student")

    analytics_store.record_events([action("viewer_open_case")], user_id=user_id)
    analytics_store.record_events(
        [action("report_open", anon_id="anon-2", session_id="sess-2")], user_id=other["id"]
    )

    start, end = wide_range()
    researchers = analytics_store.overview(start, end, account_type="researcher")
    assert [t["name"] for t in researchers["top_actions"]] == ["viewer_open_case"]


def test_audience_filter_splits_signed_in_from_anonymous(store):
    analytics_store, _, user_id = store
    analytics_store.record_events([action("viewer_open_case")], user_id=user_id)
    analytics_store.record_events(
        [action("auth_open_modal", anon_id="anon-2", session_id="sess-2")], user_id=None
    )

    start, end = wide_range()
    assert analytics_store.overview(
        start, end, audience=analytics_store.AUDIENCE_SIGNED_IN
    )["totals"]["events"] == 1
    assert analytics_store.overview(
        start, end, audience=analytics_store.AUDIENCE_ANONYMOUS
    )["totals"]["events"] == 1
    assert analytics_store.overview(start, end)["totals"]["events"] == 2


def test_events_outside_the_range_are_excluded(store):
    analytics_store, _, user_id = store
    analytics_store.record_events([action("viewer_open_case")], user_id=user_id)

    now = utcnow()
    long_ago = analytics_store.overview(now - timedelta(days=30), now - timedelta(days=20))
    assert long_ago["totals"]["events"] == 0
    assert long_ago["top_actions"] == []


def test_people_counts_distinct_browsers_not_events(store):
    analytics_store, _, user_id = store
    analytics_store.record_events([action("viewer_open_case")] * 4, user_id=user_id)
    analytics_store.record_events(
        [action("viewer_open_case", anon_id="anon-2", session_id="sess-2")], user_id=user_id
    )

    data = analytics_store.overview(*wide_range())
    assert data["totals"]["events"] == 5
    assert data["totals"]["people"] == 2
    assert data["top_actions"][0]["people"] == 2


# ---- where visitors came from ----------------------------------------------
#
# The location and device columns are the map's whole substance, and every one
# of them is written by the server from the request rather than by the client.
# These tests are mostly about that boundary.

GEO_DE = {
    "country_code": "DE", "country_name": "Germany", "region": "Berlin",
    "city": "Berlin", "latitude": 52.52, "longitude": 13.40,
}
GEO_US = {
    "country_code": "US", "country_name": "United States", "region": "Maryland",
    "city": "Baltimore", "latitude": 39.29, "longitude": -76.61,
}


def test_the_batch_stamps_location_and_device_on_every_row(store):
    analytics_store, _, user_id = store
    analytics_store.record_events(
        [action("upload_start_inference"), page("/upload", 5000)],
        user_id=user_id, ip="203.0.113.7", geo=GEO_DE, device="mobile",
    )

    from sqlalchemy import select
    from models.analytics_event import AnalyticsEvent
    from models.engine import session_scope
    with session_scope() as s:
        rows = s.execute(select(AnalyticsEvent)).scalars().all()
    assert len(rows) == 2
    assert {r.ip_address for r in rows} == {"203.0.113.7"}
    assert {r.country_code for r in rows} == {"DE"}
    assert {r.city for r in rows} == {"Berlin"}
    assert {r.device_type for r in rows} == {"mobile"}


def test_the_client_cannot_claim_a_country_or_a_device(store):
    """The same rule that already governs plan and account_type: an event body
    that names its own location would make the map fiction."""
    analytics_store, _, user_id = store
    analytics_store.record_events(
        [action("upload_start_inference", country_code="ZZ", ip_address="1.2.3.4",
                device_type="tablet", city="Atlantis")],
        user_id=user_id, ip="203.0.113.7", geo=GEO_DE, device="desktop",
    )

    from sqlalchemy import select
    from models.analytics_event import AnalyticsEvent
    from models.engine import session_scope
    with session_scope() as s:
        row = s.execute(select(AnalyticsEvent)).scalars().one()
    assert row.country_code == "DE"
    assert row.city == "Berlin"
    assert row.ip_address == "203.0.113.7"
    assert row.device_type == "desktop"


def test_a_batch_with_no_location_still_records(store):
    """Local dev, a private address, or no GeoLite2 database installed. The
    events are worth more than the columns they can't fill."""
    analytics_store, _, user_id = store
    assert analytics_store.record_events(
        [action("upload_start_inference")], user_id=user_id, ip="127.0.0.1",
    ) == 1

    start, end = wide_range()
    assert analytics_store.overview(start, end)["by_country"] == []


def test_countries_are_grouped_and_ranked_by_sessions(store):
    analytics_store, _, user_id = store
    analytics_store.record_events(
        [action("viewer_open_case", anon_id="a1", session_id="s1")],
        user_id=user_id, ip="203.0.113.7", geo=GEO_DE, device="desktop",
    )
    analytics_store.record_events(
        [action("viewer_open_case", anon_id="a2", session_id="s2"),
         action("report_open", anon_id="a2", session_id="s2")],
        ip="198.51.100.4", geo=GEO_US, device="mobile",
    )
    analytics_store.record_events(
        [action("viewer_open_case", anon_id="a3", session_id="s3")],
        ip="198.51.100.9", geo=GEO_US, device="desktop",
    )

    start, end = wide_range()
    by_country = analytics_store.overview(start, end)["by_country"]
    assert [c["country_code"] for c in by_country] == ["US", "DE"]
    assert by_country[0] == {
        "country_code": "US", "country_name": "United States",
        "sessions": 2, "people": 2, "events": 3,
    }


def test_picking_a_country_narrows_the_whole_response(store):
    """Having clicked into Germany, the feature panels should be Germany's too,
    or the page is showing two different things at once."""
    analytics_store, _, user_id = store
    analytics_store.record_events(
        [action("viewer_open_case", anon_id="a1", session_id="s1")],
        user_id=user_id, ip="203.0.113.7", geo=GEO_DE, device="desktop",
    )
    analytics_store.record_events(
        [action("report_open", anon_id="a2", session_id="s2")],
        ip="198.51.100.4", geo=GEO_US, device="mobile",
    )

    start, end = wide_range()
    german = analytics_store.overview(start, end, country="DE")
    assert german["totals"]["events"] == 1
    assert [a["name"] for a in german["top_actions"]] == ["viewer_open_case"]
    assert [d["device_type"] for d in german["by_device"]] == ["desktop"]
    # Cities are only queried once a country is picked — on the whole world it
    # would be thousands of rows nothing draws.
    assert [c["city"] for c in german["by_city"]] == ["Berlin"]
    assert analytics_store.overview(start, end)["by_city"] == []


def test_devices_are_counted_by_session(store):
    analytics_store, _, _ = store
    analytics_store.record_events(
        [action("viewer_open_case", anon_id="a1", session_id="s1"),
         action("report_open", anon_id="a1", session_id="s1")],
        ip="203.0.113.7", geo=GEO_DE, device="mobile",
    )
    analytics_store.record_events(
        [action("viewer_open_case", anon_id="a2", session_id="s2")],
        ip="198.51.100.4", geo=GEO_US, device="desktop",
    )

    start, end = wide_range()
    by_device = {d["device_type"]: d for d in analytics_store.overview(*wide_range())["by_device"]}
    assert by_device["mobile"]["sessions"] == 1
    assert by_device["desktop"]["sessions"] == 1
    assert start < end  # the range used above


# ---- new vs returning, and the previous period -----------------------------
#
# Both need events genuinely older than the window under test, and the client's
# `ts` can't produce them: record_events clamps a claimed timestamp to MAX_AGE
# (48 hours), so an event saying it happened last month lands in the last two
# days. The row has to be moved after the fact.

def backdate(session_id, when):
    """Move every row of one visit back to `when`."""
    from sqlalchemy import update
    from models.analytics_event import AnalyticsEvent
    from models.engine import session_scope
    with session_scope() as s:
        s.execute(
            update(AnalyticsEvent)
            .where(AnalyticsEvent.session_id == session_id)
            .values(created_at=when)
        )



def test_a_visitor_seen_before_the_range_counts_as_returning(store):
    analytics_store, _, _ = store
    now = utcnow()
    old = now - timedelta(days=40)

    # anon "a1" was here before the window; "a2" is new to it.
    analytics_store.record_events([action("viewer_open_case", anon_id="a1", session_id="s0")])
    backdate("s0", old)
    analytics_store.record_events(
        [action("viewer_open_case", anon_id="a1", session_id="s1"),
         action("viewer_open_case", anon_id="a2", session_id="s2")],
    )

    split = analytics_store.overview(now - timedelta(days=1), now + timedelta(days=1))
    assert split["new_vs_returning"] == {"returning": 1, "new": 1}


def test_new_and_returning_add_up_to_the_headline_figure(store):
    analytics_store, _, _ = store
    analytics_store.record_events([
        action("viewer_open_case", anon_id=f"a{i}", session_id=f"s{i}") for i in range(5)
    ])

    data = analytics_store.overview(*wide_range())
    split = data["new_vs_returning"]
    assert split["new"] + split["returning"] == data["totals"]["people"] == 5


def test_the_previous_period_is_the_window_before_this_one(store):
    analytics_store, _, _ = store
    now = utcnow()
    # Two events fifteen days ago, one today. A ten-day window ending now holds
    # the one; the ten days before it hold the two.
    for i in range(2):
        analytics_store.record_events([
            action("report_open", anon_id=f"old{i}", session_id=f"olds{i}"),
        ])
        backdate(f"olds{i}", now - timedelta(days=15))
    analytics_store.record_events([action("report_open", anon_id="new", session_id="news")])

    data = analytics_store.overview(now - timedelta(days=10), now + timedelta(minutes=1))
    assert data["totals"]["events"] == 1
    assert data["previous"]["events"] == 2
    assert data["previous"]["people"] == 2


def test_hour_and_weekday_buckets_cover_the_events(store):
    analytics_store, _, _ = store
    analytics_store.record_events([
        action("report_open", anon_id="a1", session_id="s1"),
        action("report_open", anon_id="a2", session_id="s2"),
    ])

    data = analytics_store.overview(*wide_range())
    assert sum(h["sessions"] for h in data["by_hour"]) == 2
    assert sum(w["sessions"] for w in data["by_weekday"]) == 2
    assert all(0 <= w["weekday"] <= 6 for w in data["by_weekday"])
    assert all(0 <= h["hour"] <= 23 for h in data["by_hour"])
