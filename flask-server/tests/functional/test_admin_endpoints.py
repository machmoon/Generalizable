"""End-to-end tests for the admin endpoints via a Flask test client.

The question these answer is who gets in. The role logic itself is covered in
tests/unit/test_role_store.py; what matters here is that the HTTP surface tells
signed-out apart from signed-in-but-not-admin, and that the refusals the store
raises come back as something the UI can show rather than a 500.
"""

import importlib

import pytest


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'admin_ep.db'}")
    monkeypatch.delenv("ADMIN_EMAILS", raising=False)

    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.user_role  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import services.plan_store  # noqa: F401
    import services.role_store as role_store
    importlib.reload(role_store)
    import api.auth as auth_mod
    importlib.reload(auth_mod)
    import api.auth_blueprint as auth_bp
    importlib.reload(auth_bp)
    import api.admin_blueprint as admin_bp
    importlib.reload(admin_bp)

    engine.reset_engine_for_tests()
    engine.create_all()
    auth_store.ensure_system_user()

    from flask import Flask
    app = Flask(__name__)
    app.register_blueprint(auth_bp.auth_blueprint, url_prefix="/api")
    app.register_blueprint(admin_bp.admin_blueprint, url_prefix="/api")
    with app.test_client() as c:
        yield c
    engine.reset_engine_for_tests()


def sign_up(client, email="a@b.com"):
    """Register and stay signed in as that account. Returns its id."""
    r = client.post("/api/auth/register", json={"email": email, "password": "password1"})
    return r.get_json()["user"]["id"]


def sign_in(client, email="a@b.com"):
    client.post("/api/auth/login", json={"email": email, "password": "password1"})


def make_admin(client, email="admin@b.com"):
    """A signed-in admin. Granted through the store, not the API — this is the
    bootstrap, and nobody can grant the first one over HTTP."""
    from services import role_store
    user_id = sign_up(client, email)
    role_store.grant(user_id, role_store.ROLE_ADMIN)
    return user_id


# ---- who gets in ------------------------------------------------------------

def test_signed_out_is_401(client):
    assert client.get("/api/admin/people").status_code == 401


def test_an_ordinary_account_is_403(client):
    """Different from 401 on purpose: signing in again won't help."""
    sign_up(client, "nobody@b.com")
    assert client.get("/api/admin/people").status_code == 403


def test_an_admin_gets_the_list(client):
    make_admin(client)
    r = client.get("/api/admin/people")
    assert r.status_code == 200
    assert r.get_json()["people"][0]["email"] == "admin@b.com"


def test_writes_are_gated_too(client):
    """Not just the read — a 403 on the list and an open POST is the worst case."""
    target = sign_up(client, "nobody@b.com")
    assert client.post(
        f"/api/admin/people/{target}/roles", json={"role": "admin"}
    ).status_code == 403
    assert client.delete(f"/api/admin/people/{target}/roles/admin").status_code == 403


# ---- the list ---------------------------------------------------------------

def test_the_list_carries_roles_and_the_vocabulary(client):
    make_admin(client)
    body = client.get("/api/admin/people").get_json()
    assert body["people"][0]["roles"] == ["admin"]
    assert body["roles"] == ["admin"]


def test_search_narrows_the_list(client):
    sign_up(client, "alice@hospital.org")
    make_admin(client)
    body = client.get("/api/admin/people?q=hospital").get_json()
    assert [p["email"] for p in body["people"]] == ["alice@hospital.org"]


def test_no_password_hash_is_returned(client):
    make_admin(client)
    assert "password_hash" not in client.get("/api/admin/people").get_json()["people"][0]


def test_junk_paging_is_a_400(client):
    make_admin(client)
    assert client.get("/api/admin/people?limit=lots").status_code == 400


# ---- granting and revoking --------------------------------------------------

def test_grant_then_revoke_round_trip(client):
    target = sign_up(client, "them@b.com")
    make_admin(client)

    granted = client.post(f"/api/admin/people/{target}/roles", json={"role": "admin"})
    assert granted.status_code == 200
    assert granted.get_json()["roles"] == ["admin"]

    revoked = client.delete(f"/api/admin/people/{target}/roles/admin")
    assert revoked.status_code == 200
    assert revoked.get_json()["roles"] == []


def test_an_unknown_role_is_a_400(client):
    target = sign_up(client, "them@b.com")
    make_admin(client)
    r = client.post(f"/api/admin/people/{target}/roles", json={"role": "superuser"})
    assert r.status_code == 400


def test_granting_to_a_missing_account_is_a_404(client):
    make_admin(client)
    r = client.post("/api/admin/people/no-such-id/roles", json={"role": "admin"})
    assert r.status_code == 404


def test_you_cannot_demote_yourself(client):
    """Two admins exist, so this is the self-demotion rule and not last-admin."""
    other = sign_up(client, "other@b.com")
    me = make_admin(client)
    client.post(f"/api/admin/people/{other}/roles", json={"role": "admin"})

    r = client.delete(f"/api/admin/people/{me}/roles/admin")
    assert r.status_code == 409
    assert r.get_json()["reason"] == "self_demote"


def test_the_last_admin_cannot_be_removed(client):
    """Even by another admin — here, the bootstrap admin removing the only one
    left is themselves, but the rule is about the count, not the identity."""
    only = make_admin(client)
    r = client.delete(f"/api/admin/people/{only}/roles/admin")
    assert r.status_code == 409
    assert r.get_json()["reason"] in ("self_demote", "last_admin")


def test_a_promoted_account_can_then_use_the_admin_api(client):
    """The whole point of the People page: an admin hands out access and it works."""
    target = sign_up(client, "them@b.com")
    make_admin(client)
    client.post(f"/api/admin/people/{target}/roles", json={"role": "admin"})

    client.post("/api/auth/logout")
    sign_in(client, "them@b.com")
    assert client.get("/api/admin/people").status_code == 200


def test_a_demoted_account_loses_access(client):
    target = sign_up(client, "them@b.com")
    make_admin(client)
    client.post(f"/api/admin/people/{target}/roles", json={"role": "admin"})
    client.delete(f"/api/admin/people/{target}/roles/admin")

    client.post("/api/auth/logout")
    sign_in(client, "them@b.com")
    assert client.get("/api/admin/people").status_code == 403


# ---- roles on the user body -------------------------------------------------

def test_me_reports_roles(client):
    make_admin(client)
    assert client.get("/api/auth/me").get_json()["user"]["roles"] == ["admin"]


def test_an_ordinary_account_reports_no_roles(client):
    sign_up(client, "nobody@b.com")
    assert client.get("/api/auth/me").get_json()["user"]["roles"] == []


def test_roles_survive_a_profile_update(client):
    """The client replaces its user object from this response; dropping roles
    here would blank the admin nav until the next reload."""
    make_admin(client)
    body = client.patch("/api/auth/me", json={"name": "Boss"}).get_json()
    assert body["user"]["roles"] == ["admin"]
