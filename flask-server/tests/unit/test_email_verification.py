"""Unit tests for "verify your email": issuing a one-time token and redeeming
it. Same fixture shape as test_password_reset.py - the rules live in the store.
"""

import importlib
from datetime import timedelta

import pytest


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'verify.db'}")
    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.email_verification  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)

    engine.reset_engine_for_tests()
    engine.create_all()
    yield auth_store
    engine.reset_engine_for_tests()


def _token_row(user_id: str):
    from sqlalchemy import select
    from models.engine import session_scope
    from models.email_verification import EmailVerificationToken
    with session_scope() as s:
        return s.execute(
            select(EmailVerificationToken)
            .where(EmailVerificationToken.user_id == user_id)
            .order_by(EmailVerificationToken.created_at.desc())
        ).scalars().first()


def test_issues_a_token_and_never_stores_the_raw(store):
    user = store.create_user("v@example.com", "password1")
    result = store.create_email_verification(user["id"])
    assert result is not None
    issued, raw = result
    assert issued["id"] == user["id"]
    assert raw
    row = _token_row(user["id"])
    assert row is not None and row.token_hash != raw


def test_redeeming_marks_the_email_verified_once(store):
    user = store.create_user("v@example.com", "password1")
    _, raw = store.create_email_verification(user["id"])

    verified = store.verify_email(raw)
    assert verified is not None
    assert verified["email_verified"] is True

    # Single use: the same link again is refused.
    assert store.verify_email(raw) is None


def test_an_expired_token_is_refused(store):
    user = store.create_user("v@example.com", "password1")
    _, raw = store.create_email_verification(user["id"])
    row = _token_row(user["id"])
    from models.engine import session_scope
    with session_scope() as s:
        s.merge(row).expires_at = row.created_at - timedelta(minutes=1)
    assert store.verify_email(raw) is None


def test_a_second_request_supersedes_the_first(store):
    user = store.create_user("v@example.com", "password1")
    _, first = store.create_email_verification(user["id"])
    _, second = store.create_email_verification(user["id"])
    assert store.verify_email(first) is None
    assert store.verify_email(second) is not None


def test_a_verified_account_gets_no_further_tokens(store):
    user = store.create_user("v@example.com", "password1")
    _, raw = store.create_email_verification(user["id"])
    assert store.verify_email(raw) is not None
    assert store.create_email_verification(user["id"]) is None


def test_garbage_tokens_are_refused(store):
    store.create_user("v@example.com", "password1")
    assert store.verify_email("") is None
    assert store.verify_email("not-a-token") is None
