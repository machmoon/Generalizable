"""End-to-end tests for the analytics endpoints via a Flask test client.

The auth blueprint is registered alongside the analytics one so a batch can be
posted with a real session cookie, which is the only way to check that events
are attributed to the account rather than to whatever the request body claims.
"""

import importlib

import pytest


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'analytics_ep.db'}")
    # Off unless a test says otherwise — that default is the thing being tested.
    monkeypatch.delenv("ANALYTICS_DASHBOARD", raising=False)

    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.usage_event  # noqa: F401
    import models.analytics_event  # noqa: F401
    import models.user_role  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import services.plan_store  # noqa: F401
    import services.role_store as role_store
    importlib.reload(role_store)
    import services.analytics_store as analytics_store
    importlib.reload(analytics_store)
    import api.auth as auth_mod
    importlib.reload(auth_mod)
    import api.auth_blueprint as auth_bp
    importlib.reload(auth_bp)
    import api.analytics_blueprint as analytics_bp
    importlib.reload(analytics_bp)

    engine.reset_engine_for_tests()
    engine.create_all()
    auth_store.ensure_system_user()

    from flask import Flask
    app = Flask(__name__)
    app.register_blueprint(auth_bp.auth_blueprint, url_prefix="/api")
    app.register_blueprint(analytics_bp.analytics_blueprint, url_prefix="/api")
    with app.test_client() as c:
        yield c
    engine.reset_engine_for_tests()


def an_action(name="viewer_open_case", **extra):
    base = {"kind": "action", "name": name, "anon_id": "anon-1", "session_id": "sess-1"}
    base.update(extra)
    return base


def sign_up(client, email="a@b.com", password="password1"):
    """Register and stay signed in as that account. Returns its id."""
    r = client.post("/api/auth/register", json={"email": email, "password": password})
    return r.get_json()["user"]["id"]


def sign_up_admin(client, email="admin@b.com"):
    """The dashboard's read endpoints need one of these; most tests below are
    about what they return, not about who may ask."""
    from services import role_store
    user_id = sign_up(client, email)
    role_store.grant(user_id, role_store.ROLE_ADMIN)
    return user_id


# ---- collecting ------------------------------------------------------------

def test_collect_accepts_events_from_a_signed_out_visitor(client):
    r = client.post("/api/analytics/collect", json={"events": [an_action("auth_open_modal")]})
    assert r.status_code == 200
    assert r.get_json() == {"stored": 1}


def test_collect_never_errors_on_junk(client):
    """A tracking call must not surface as a failure in the app it measures."""
    for body in ({}, {"events": []}, {"events": "nonsense"}, {"events": [{"kind": "nope"}]}):
        r = client.post("/api/analytics/collect", json=body)
        assert r.status_code == 200
        assert r.get_json()["stored"] == 0


def test_a_signed_in_batch_is_attributed_to_that_account(client, monkeypatch):
    from services import role_store
    user_id = sign_up(client)
    client.patch("/api/auth/me", json={"account_type": "researcher"})

    assert client.post(
        "/api/analytics/collect", json={"events": [an_action(plan="enterprise")]}
    ).get_json() == {"stored": 1}

    # Same account reads it back, so the batch stays attributed to one person.
    role_store.grant(user_id, role_store.ROLE_ADMIN)
    monkeypatch.setenv("ANALYTICS_DASHBOARD", "true")
    data = client.get("/api/analytics/overview").get_json()
    assert data["totals"]["signed_in_people"] == 1
    assert data["by_plan"] == [{"plan": "free", "events": 1, "people": 1}]
    assert data["by_account_type"][0]["account_type"] == "researcher"


# ---- rate limiting ---------------------------------------------------------

def test_collect_refuses_a_caller_past_the_limit(client, monkeypatch):
    monkeypatch.setenv("ANALYTICS_RATE_LIMIT_PER_MIN", "3")

    for _ in range(3):
        assert client.post(
            "/api/analytics/collect", json={"events": [an_action()]}
        ).status_code == 200

    r = client.post("/api/analytics/collect", json={"events": [an_action()]})
    assert r.status_code == 429
    assert r.get_json()["stored"] == 0


def test_a_refused_batch_is_not_stored(client, monkeypatch):
    monkeypatch.setenv("ANALYTICS_RATE_LIMIT_PER_MIN", "1")
    client.post("/api/analytics/collect", json={"events": [an_action()]})
    client.post("/api/analytics/collect", json={"events": [an_action("viewer_measure")]})

    sign_up_admin(client)
    monkeypatch.setenv("ANALYTICS_DASHBOARD", "true")
    # The sign-up above is a different endpoint, so it doesn't spend the budget.
    names = [r["name"] for r in client.get("/api/analytics/overview").get_json()["top_actions"]]
    assert names == ["viewer_open_case"]


def test_the_limit_is_per_ip(client, monkeypatch):
    monkeypatch.setenv("ANALYTICS_RATE_LIMIT_PER_MIN", "1")
    body = {"events": [an_action()]}

    assert client.post(
        "/api/analytics/collect", json=body, environ_overrides={"REMOTE_ADDR": "10.0.0.1"}
    ).status_code == 200
    assert client.post(
        "/api/analytics/collect", json=body, environ_overrides={"REMOTE_ADDR": "10.0.0.1"}
    ).status_code == 429
    # A different caller still has its own budget.
    assert client.post(
        "/api/analytics/collect", json=body, environ_overrides={"REMOTE_ADDR": "10.0.0.2"}
    ).status_code == 200


def test_the_limit_can_be_turned_off(client, monkeypatch):
    monkeypatch.setenv("ANALYTICS_RATE_LIMIT_PER_MIN", "0")
    for _ in range(50):
        assert client.post(
            "/api/analytics/collect", json={"events": [an_action()]}
        ).status_code == 200


def test_collect_dedupes_a_replayed_request(client):
    """The endpoint-level version of the store's dedup: the same body twice."""
    body = {"events": [an_action(id="evt-1"), an_action("viewer_measure", id="evt-2")]}
    assert client.post("/api/analytics/collect", json=body).get_json() == {"stored": 2}
    assert client.post("/api/analytics/collect", json=body).get_json() == {"stored": 0}


# ---- the gate --------------------------------------------------------------

def test_the_dashboard_endpoints_are_404_by_default(client):
    assert client.get("/api/analytics/overview").status_code == 404
    assert client.get("/api/analytics/meta").status_code == 404


def test_collect_still_works_while_the_dashboard_is_off(client):
    assert client.post(
        "/api/analytics/collect", json={"events": [an_action()]}
    ).status_code == 200


def test_the_endpoints_open_when_the_flag_is_set_and_you_are_an_admin(client, monkeypatch):
    sign_up_admin(client)
    monkeypatch.setenv("ANALYTICS_DASHBOARD", "true")
    assert client.get("/api/analytics/overview").status_code == 200
    assert client.get("/api/analytics/meta").status_code == 200


def test_the_flag_alone_is_not_enough(client, monkeypatch):
    """Signed out, with the flag on: still refused."""
    monkeypatch.setenv("ANALYTICS_DASHBOARD", "true")
    assert client.get("/api/analytics/overview").status_code == 401
    assert client.get("/api/analytics/meta").status_code == 401


def test_an_ordinary_account_is_refused(client, monkeypatch):
    sign_up(client, "nobody@b.com")
    monkeypatch.setenv("ANALYTICS_DASHBOARD", "true")
    assert client.get("/api/analytics/overview").status_code == 403
    assert client.get("/api/analytics/meta").status_code == 403


def test_admin_alone_is_not_enough(client):
    """Flag off beats being an admin, and it 404s rather than 403s — a deploy
    that never enabled analytics shouldn't confirm the endpoints are there."""
    sign_up_admin(client)
    assert client.get("/api/analytics/overview").status_code == 404
    assert client.get("/api/analytics/meta").status_code == 404


# ---- querying --------------------------------------------------------------

def test_overview_rejects_a_backwards_range(client, monkeypatch):
    sign_up_admin(client)
    monkeypatch.setenv("ANALYTICS_DASHBOARD", "true")
    r = client.get("/api/analytics/overview?from=2026-08-08&to=2026-08-01")
    assert r.status_code == 400


def test_overview_rejects_an_unknown_audience(client, monkeypatch):
    sign_up_admin(client)
    monkeypatch.setenv("ANALYTICS_DASHBOARD", "true")
    assert client.get("/api/analytics/overview?audience=everyone").status_code == 400


def test_the_to_date_includes_that_whole_day(client, monkeypatch):
    """A range ending today must contain events recorded today."""
    sign_up_admin(client)
    monkeypatch.setenv("ANALYTICS_DASHBOARD", "true")
    client.post("/api/analytics/collect", json={"events": [an_action()]})

    from models.job import utcnow
    today = utcnow().date().isoformat()
    data = client.get(f"/api/analytics/overview?from={today}&to={today}").get_json()
    assert data["totals"]["events"] == 1


def test_all_time_reaches_past_the_date_range(client, monkeypatch):
    """?range=all ignores from/to and starts at the oldest event on record."""
    sign_up_admin(client)
    monkeypatch.setenv("ANALYTICS_DASHBOARD", "true")
    client.post("/api/analytics/collect", json={"events": [an_action()]})

    # A window that deliberately excludes today, so a range that was honoured
    # would report nothing.
    empty = client.get("/api/analytics/overview?from=2020-01-01&to=2020-01-02").get_json()
    assert empty["totals"]["events"] == 0

    data = client.get(
        "/api/analytics/overview?range=all&from=2020-01-01&to=2020-01-02"
    ).get_json()
    assert data["totals"]["events"] == 1


def test_all_time_survives_an_empty_table(client, monkeypatch):
    """No events at all means no earliest event to start from."""
    sign_up_admin(client)
    monkeypatch.setenv("ANALYTICS_DASHBOARD", "true")
    r = client.get("/api/analytics/overview?range=all")
    assert r.status_code == 200
    assert r.get_json()["totals"]["events"] == 0


def test_meta_lists_the_filters_the_dashboard_offers(client, monkeypatch):
    sign_up_admin(client)
    monkeypatch.setenv("ANALYTICS_DASHBOARD", "true")
    meta = client.get("/api/analytics/meta").get_json()
    assert "free" in meta["plans"] and "enterprise" in meta["plans"]
    assert meta["account_types"] == ["patient", "clinician", "researcher", "student"]
    assert "viewer_open_case" in meta["action_names"]


# ---- the account_type write path -------------------------------------------

def test_account_type_round_trips_through_patch_me(client):
    client.post("/api/auth/register", json={"email": "a@b.com", "password": "password1"})

    r = client.patch("/api/auth/me", json={"account_type": "clinician"})
    assert r.status_code == 200
    assert r.get_json()["user"]["account_type"] == "clinician"
    assert client.get("/api/auth/me").get_json()["user"]["account_type"] == "clinician"


def test_account_type_can_be_cleared(client):
    client.post("/api/auth/register", json={"email": "a@b.com", "password": "password1"})
    client.patch("/api/auth/me", json={"account_type": "student"})

    r = client.patch("/api/auth/me", json={"account_type": ""})
    assert r.get_json()["user"]["account_type"] is None


def test_an_invented_account_type_is_refused(client):
    client.post("/api/auth/register", json={"email": "a@b.com", "password": "password1"})
    assert client.patch("/api/auth/me", json={"account_type": "wizard"}).status_code == 400


def test_name_and_account_type_can_be_sent_together(client):
    client.post("/api/auth/register", json={"email": "a@b.com", "password": "password1"})

    user = client.patch(
        "/api/auth/me", json={"name": "Sam", "account_type": "patient"}
    ).get_json()["user"]
    assert user["name"] == "Sam"
    assert user["account_type"] == "patient"
