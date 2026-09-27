#!/usr/bin/env python3
"""Fill the analytics tables with plausible traffic, so the Usage dashboard can
be looked at (or demonstrated) without waiting for real visitors.

Two things otherwise stand between a fresh checkout and a populated dashboard,
and this script exists because neither is quick to solve:

  * On a development machine every request comes from 127.0.0.1, which has no
    location and never will, so the visitor map is permanently empty.
  * Real locations need MaxMind's GeoLite2 database, which needs an account and
    a licence key.

The rows written here carry locations directly, so the map fills in with no
GeoLite2 database present at all.

    python scripts/seed_demo_analytics.py            # 30 days of traffic
    python scripts/seed_demo_analytics.py --days 90
    python scripts/seed_demo_analytics.py --clear    # remove seeded rows again

Everything it writes is tagged with a recognisable anon_id prefix, so --clear
removes exactly what this script added and leaves real events alone.

NOT for production. It writes fabricated rows into the analytics table; on a
real deploy that is corrupting the only record of what people actually did.
"""

import argparse
import os
import random
import sys
import uuid
from datetime import timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models.analytics_event import KIND_ACTION, KIND_PAGE_VIEW, AnalyticsEvent  # noqa: E402
from models.engine import session_scope  # noqa: E402
from models.job import utcnow  # noqa: E402
from services.analytics_store import ACTION_NAMES, ROUTE_PATTERNS  # noqa: E402

# Anything this script writes starts with this, so --clear can find it again.
SEED_PREFIX = "seed-"

# (country code, country name, region, city, lat, lon, weight). Weights make the
# map look like a real audience — one dominant country and a long tail — rather
# than an evenly-shaded world, which is what a uniform random pick produces.
PLACES = [
    ("US", "United States", "Maryland", "Baltimore", 39.29, -76.61, 26),
    ("US", "United States", "New York", "New York", 40.71, -74.01, 14),
    ("US", "United States", "California", "San Francisco", 37.77, -122.42, 11),
    ("US", "United States", "Massachusetts", "Boston", 42.36, -71.06, 7),
    ("DE", "Germany", "Berlin", "Berlin", 52.52, 13.40, 8),
    ("GB", "United Kingdom", "England", "London", 51.51, -0.13, 7),
    ("CN", "China", "Beijing", "Beijing", 39.90, 116.41, 6),
    ("IN", "India", "Maharashtra", "Mumbai", 19.08, 72.88, 5),
    ("CA", "Canada", "Ontario", "Toronto", 43.65, -79.38, 4),
    ("JP", "Japan", "Tokyo", "Tokyo", 35.68, 139.69, 3),
    ("BR", "Brazil", "São Paulo", "São Paulo", -23.55, -46.63, 3),
    ("AU", "Australia", "New South Wales", "Sydney", -33.87, 151.21, 2),
    ("FR", "France", "Île-de-France", "Paris", 48.86, 2.35, 2),
    ("NL", "Netherlands", "South Holland", "Delft", 52.01, 4.36, 2),
    ("KR", "South Korea", "Seoul", "Seoul", 37.57, 126.98, 2),
    ("NG", "Nigeria", "Lagos", "Lagos", 6.52, 3.38, 1),
    ("ZA", "South Africa", "Gauteng", "Johannesburg", -26.20, 28.05, 1),
    ("EG", "Egypt", "Cairo", "Cairo", 30.04, 31.24, 1),
    ("MX", "Mexico", "Mexico City", "Mexico City", 19.43, -99.13, 1),
    ("IT", "Italy", "Lazio", "Rome", 41.90, 12.50, 1),
]

DEVICES = [("desktop", 70), ("mobile", 24), ("tablet", 6)]
PLANS = [(None, 62), ("free", 28), ("pro", 8), ("team", 2)]
ACCOUNT_TYPES = ["researcher", "clinician", "student", "patient", None]

# Weighted so the "most-used features" panel has a shape. An even spread makes
# every bar the same length, which tells you nothing about anything.
WEIGHTED_ACTIONS = [
    ("viewer_open_case", 24), ("dataset_search", 18), ("viewer_toggle_organ", 12),
    ("upload_files_selected", 8), ("upload_start_inference", 7), ("account_open_settings", 6),
    ("viewer_change_layout", 5), ("assistant_open", 4), ("report_open", 4),
    ("auth_sign_in", 3), ("viewer_measure", 3), ("dataset_open_compare", 2),
    ("assistant_send_message", 2), ("auth_open_modal", 2),
]
WEIGHTED_ROUTES = [
    ("/dashboard", 26), ("/case/:caseId", 22), ("/", 18), ("/upload", 12),
    ("/compare", 6), ("/account", 5), ("/account/analytics", 3), ("/team", 3),
]


def pick(weighted):
    """One item from [(value, weight), ...]."""
    values, weights = zip(*weighted)
    return random.choices(values, weights=weights, k=1)[0]


def build_rows(days: int, visitors: int) -> list[AnalyticsEvent]:
    now = utcnow()
    rows: list[AnalyticsEvent] = []

    for v in range(visitors):
        anon_id = f"{SEED_PREFIX}{uuid.uuid4().hex[:16]}"
        place = pick([(p, p[6]) for p in PLACES])
        code, country, region, city, lat, lon, _ = place
        device = pick(DEVICES)
        plan = pick(PLANS)
        # Only a signed-in visitor has a plan, and only they have a type — the
        # same rule the real recorder follows.
        account_type = random.choice(ACCOUNT_TYPES) if plan else None
        ip = f"{random.randint(11, 223)}.{random.randint(0, 255)}." \
             f"{random.randint(0, 255)}.{random.randint(1, 254)}"

        # Some people come back. Without this every visitor is "new" and the
        # new-vs-returning ring is one solid colour.
        visits = random.choices([1, 2, 3, 5], weights=[62, 22, 11, 5], k=1)[0]
        for visit in range(visits):
            session_id = f"{SEED_PREFIX}{uuid.uuid4().hex[:16]}"
            # A repeat visitor's FIRST visit is placed before the window, not
            # inside it. Two panels depend on there being history older than the
            # range being viewed: "returning" means an anon_id seen before the
            # range started, and every headline number is compared against the
            # window before this one. Seed only inside the range and both come
            # out empty — nobody returning, nothing to compare against.
            earlier = visits > 1 and visit == 0
            when = now - timedelta(
                days=random.uniform(days, days * 2) if earlier
                else random.uniform(0, days),
                hours=random.choice([0, 0, 1, 2, 3, 4, 5, 6, 7, 8]),
            )
            # Weekday-and-daytime biased, so the "when people visit" panel shows
            # the working-hours shape real traffic has.
            if when.weekday() >= 5 and random.random() < 0.6:
                when -= timedelta(days=random.randint(1, 3))

            common = dict(
                anon_id=anon_id, session_id=session_id, created_at=when,
                ip_address=ip, country_code=code, country_name=country,
                region=region, city=city, latitude=lat, longitude=lon,
                device_type=device, plan=plan, account_type=account_type,
            )

            # A visit is a couple of page views and a handful of actions.
            for _ in range(random.randint(1, 4)):
                route = pick(WEIGHTED_ROUTES)
                if route not in ROUTE_PATTERNS:
                    continue
                rows.append(AnalyticsEvent(
                    id=str(uuid.uuid4()), kind=KIND_PAGE_VIEW, name=route, route=route,
                    duration_ms=int(random.lognormvariate(10.2, 1.1)), **common,
                ))
            for _ in range(random.randint(0, 9)):
                action = pick(WEIGHTED_ACTIONS)
                if action not in ACTION_NAMES:
                    continue
                rows.append(AnalyticsEvent(
                    id=str(uuid.uuid4()), kind=KIND_ACTION, name=action,
                    route=pick(WEIGHTED_ROUTES), duration_ms=None, **common,
                ))

    return rows


def clear() -> int:
    from sqlalchemy import delete
    with session_scope() as s:
        return s.execute(
            delete(AnalyticsEvent).where(AnalyticsEvent.anon_id.startswith(SEED_PREFIX))
        ).rowcount or 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--days", type=int, default=30,
                        help="How far back to spread the traffic (default: 30)")
    parser.add_argument("--visitors", type=int, default=320,
                        help="Distinct browsers to invent (default: 320)")
    parser.add_argument("--clear", action="store_true",
                        help="Delete previously seeded rows and stop")
    parser.add_argument("--seed", type=int, default=None,
                        help="Random seed, for a repeatable dataset")
    args = parser.parse_args()

    if args.clear:
        print(f"Removed {clear()} seeded event(s).")
        return 0

    if args.seed is not None:
        random.seed(args.seed)

    rows = build_rows(args.days, args.visitors)
    with session_scope() as s:
        s.add_all(rows)

    print(f"Seeded {len(rows)} events from {args.visitors} visitors over "
          f"{args.days} days.\n"
          "Start the backend with ANALYTICS_DASHBOARD=true and open "
          "/account/analytics as an admin.\n"
          "Run again with --clear to remove them.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
