"""Unit tests for the account/session store: registration, credential checks,
argon2 hashing, and opaque session tokens (create / resolve / expire / revoke).

Each test gets its own temp-file SQLite DB via create_all() — no Flask app, no
nibabel — so the auth core is covered independently of the request layer.
"""

import importlib
from datetime import timedelta

import pytest


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'auth.db'}")
    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)

    engine.reset_engine_for_tests()
    engine.create_all()
    yield auth_store
    engine.reset_engine_for_tests()


def test_register_and_authenticate(store):
    user = store.create_user("Jane@Example.com ", "hunter2pass")
    # email normalised (trim + lowercase); no password hash leaks out
    assert user["email"] == "jane@example.com"
    assert "password_hash" not in user

    assert store.authenticate("jane@example.com", "hunter2pass")["id"] == user["id"]
    assert store.authenticate("JANE@example.com", "hunter2pass") is not None  # case-insensitive
    assert store.authenticate("jane@example.com", "wrong") is None
    assert store.authenticate("nobody@example.com", "whatever") is None


def test_duplicate_email_rejected(store):
    store.create_user("dup@example.com", "password1")
    with pytest.raises(store.EmailTakenError):
        store.create_user("Dup@example.com", "password2")  # same email, different case


def test_password_is_hashed_not_plaintext(store):
    from models.engine import session_scope
    from models.user import User
    store.create_user("hash@example.com", "supersecret")
    with session_scope() as s:
        from sqlalchemy import select
        u = s.execute(select(User).where(User.email == "hash@example.com")).scalar_one()
        assert u.password_hash and u.password_hash != "supersecret"
        assert u.password_hash.startswith("$argon2")


def test_session_create_resolve_revoke(store):
    user = store.create_user("s@example.com", "password1")
    token = store.create_session(user["id"])
    assert isinstance(token, str) and len(token) > 20

    resolved = store.resolve_session(token)
    assert resolved["id"] == user["id"]

    assert store.resolve_session("not-a-real-token") is None
    assert store.resolve_session(None) is None

    assert store.revoke_session(token) is True
    assert store.resolve_session(token) is None      # revoked -> gone
    assert store.revoke_session(token) is False       # already revoked


def test_expired_session_not_resolved(store):
    from models.engine import session_scope
    from models.auth_session import AuthSession
    from models.job import utcnow
    user = store.create_user("exp@example.com", "password1")
    token = store.create_session(user["id"])
    with session_scope() as s:
        from sqlalchemy import select
        sess = s.execute(select(AuthSession)).scalar_one()
        sess.expires_at = utcnow() - timedelta(seconds=1)
    assert store.resolve_session(token) is None


def test_system_user_excluded_from_auth(store):
    sid = store.ensure_system_user()
    # idempotent
    assert store.ensure_system_user() == sid
    # a session for the system user never resolves to a usable login
    token = store.create_session(sid)
    assert store.resolve_session(token) is None
    # and it can't authenticate (no password)
    assert store.authenticate("system@bodymaps.local", "anything") is None
