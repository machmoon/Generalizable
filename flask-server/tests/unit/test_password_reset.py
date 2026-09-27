"""Unit tests for "I forgot my password": handing out a one-time token and
redeeming it.

Same shape as test_auth_store.py — a temp-file SQLite DB per test, no Flask app
— because the interesting rules all live in the store: who gets a token at all,
how long it lives, that it works exactly once, and what redeeming one does to
the sessions the account already had.
"""

import importlib
from datetime import timedelta

import pytest


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'reset.db'}")
    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.password_reset  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)

    engine.reset_engine_for_tests()
    engine.create_all()
    yield auth_store
    engine.reset_engine_for_tests()


def _token_row(user_id: str):
    from sqlalchemy import select
    from models.engine import session_scope
    from models.password_reset import PasswordResetToken
    with session_scope() as s:
        return s.execute(
            select(PasswordResetToken)
            .where(PasswordResetToken.user_id == user_id)
            .order_by(PasswordResetToken.created_at.desc())
        ).scalars().first()


# ---- who gets a token ------------------------------------------------------

def test_reset_issues_a_token_for_a_password_account(store):
    user = store.create_user("jane@example.com", "oldpassword")
    result = store.create_password_reset("Jane@Example.COM ")  # normalised like login
    assert result is not None
    issued, raw = result
    assert issued["id"] == user["id"]
    assert raw  # the raw token is returned to the caller, never stored


def test_the_raw_token_is_not_stored(store):
    """A database leak must not hand out live reset links."""
    user = store.create_user("jane@example.com", "oldpassword")
    _, raw = store.create_password_reset("jane@example.com")

    stored = _token_row(user["id"]).token_hash
    assert stored != raw
    assert len(stored) == 64  # sha256 hex, same as the session tokens


def test_unknown_email_gets_nothing(store):
    assert store.create_password_reset("nobody@example.com") is None
    assert store.create_password_reset("") is None


def test_oauth_only_account_gets_nothing(store):
    """There is no password on the account to reset, so a link would lead to a
    page that can't help. The endpoint still answers 200 — see the blueprint."""
    store.upsert_oauth_user("google", "g-1", "oauth@example.com", email_verified=True)
    assert store.create_password_reset("oauth@example.com") is None


def test_a_second_request_supersedes_the_first(store):
    store.create_user("jane@example.com", "oldpassword")
    _, first = store.create_password_reset("jane@example.com")
    _, second = store.create_password_reset("jane@example.com")

    assert store.reset_password(first, "newpassword1") is None
    assert store.reset_password(second, "newpassword1") is not None


# ---- redeeming it ----------------------------------------------------------

def test_reset_changes_the_password(store):
    store.create_user("jane@example.com", "oldpassword")
    _, raw = store.create_password_reset("jane@example.com")

    assert store.reset_password(raw, "brandnewpass")["email"] == "jane@example.com"
    assert store.authenticate("jane@example.com", "brandnewpass") is not None
    assert store.authenticate("jane@example.com", "oldpassword") is None


def test_a_token_works_exactly_once(store):
    store.create_user("jane@example.com", "oldpassword")
    _, raw = store.create_password_reset("jane@example.com")

    assert store.reset_password(raw, "brandnewpass") is not None
    assert store.reset_password(raw, "another1pass") is None
    # and the second attempt didn't take
    assert store.authenticate("jane@example.com", "brandnewpass") is not None


def test_an_expired_token_is_refused(store):
    user = store.create_user("jane@example.com", "oldpassword")
    _, raw = store.create_password_reset("jane@example.com")

    from models.engine import session_scope
    from models.job import utcnow
    from models.password_reset import PasswordResetToken
    with session_scope() as s:
        s.get(PasswordResetToken, _token_row(user["id"]).id).expires_at = (
            utcnow() - timedelta(minutes=1)
        )

    assert store.reset_password(raw, "brandnewpass") is None
    assert store.authenticate("jane@example.com", "oldpassword") is not None


def test_garbage_tokens_are_refused(store):
    store.create_user("jane@example.com", "oldpassword")
    store.create_password_reset("jane@example.com")
    assert store.reset_password("not-a-real-token", "brandnewpass") is None
    assert store.reset_password("", "brandnewpass") is None


def test_reset_signs_out_every_other_session(store):
    """Someone locked out may be locked out *because* another browser holds the
    account. A reset that leaves those alive is cosmetic."""
    user = store.create_user("jane@example.com", "oldpassword")
    live = store.create_session(user["id"])
    assert store.resolve_session(live) is not None

    _, raw = store.create_password_reset("jane@example.com")
    store.reset_password(raw, "brandnewpass")

    assert store.resolve_session(live) is None


def test_reset_cancels_a_pending_deletion(store):
    """Proving you control the mailbox is the same signal as signing in, which
    already undoes a deletion request."""
    user = store.create_user("jane@example.com", "oldpassword")
    store.request_deletion(user["id"])

    _, raw = store.create_password_reset("jane@example.com")
    assert store.reset_password(raw, "brandnewpass") is not None
    assert store.authenticate("jane@example.com", "brandnewpass") is not None


def test_an_account_past_its_grace_window_is_gone(store):
    user = store.create_user("jane@example.com", "oldpassword")
    store.request_deletion(user["id"])

    from models.engine import session_scope
    from models.job import utcnow
    from models.user import User
    with session_scope() as s:
        s.get(User, user["id"]).deletion_requested_at = (
            utcnow() - timedelta(days=store.DELETION_GRACE_DAYS + 1)
        )

    assert store.create_password_reset("jane@example.com") is None


# ---- housekeeping ----------------------------------------------------------

def test_purge_drops_spent_and_expired_tokens_only(store):
    store.create_user("jane@example.com", "oldpassword")
    store.create_user("bob@example.com", "oldpassword")

    _, spent = store.create_password_reset("jane@example.com")
    store.reset_password(spent, "brandnewpass")
    _, live = store.create_password_reset("bob@example.com")

    assert store.purge_expired_reset_tokens() == 1
    # the live one survived and still works
    assert store.reset_password(live, "brandnewpass") is not None
