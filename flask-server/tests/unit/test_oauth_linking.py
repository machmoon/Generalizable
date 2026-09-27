"""Unit tests for OAuth account resolution (auth_store.upsert_oauth_user).

This is the security-sensitive half of B2: which OAuth login maps to which
local account. The rules under test:
  - a returning identity is matched by (provider, provider_user_id), never email
  - a first-time login links to an existing account ONLY if the provider
    verified the email
  - an unverified email colliding with an existing account is refused
  - otherwise a new OAuth-only account is created
"""

import importlib

import pytest


@pytest.fixture()
def store(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'oauth.db'}")
    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import models.user  # noqa: F401
    import models.auth_session  # noqa: F401
    import models.oauth_identity  # noqa: F401
    import services.auth_store as auth_store
    importlib.reload(auth_store)

    engine.reset_engine_for_tests()
    engine.create_all()
    yield auth_store
    engine.reset_engine_for_tests()


def test_creates_new_account_for_first_oauth_login(store):
    user = store.upsert_oauth_user("google", "sub-1", "New@Example.com", True)
    assert user["email"] == "new@example.com"
    assert user["email_verified"] is True
    # OAuth-only account has no password, so password login must fail.
    assert store.authenticate("new@example.com", "anything") is None


def test_returning_identity_matched_by_provider_id_not_email(store):
    first = store.upsert_oauth_user("google", "sub-1", "old@example.com", True)
    # Same subject id, different email upstream (user changed their address).
    again = store.upsert_oauth_user("google", "sub-1", "changed@example.com", True)
    assert again["id"] == first["id"]  # same account, matched by sub


def test_same_email_different_providers_link_to_one_account(store):
    g = store.upsert_oauth_user("google", "g-1", "dual@example.com", True)
    gh = store.upsert_oauth_user("github", "gh-1", "dual@example.com", True)
    assert g["id"] == gh["id"]


def test_links_to_password_account_when_email_verified(store):
    local = store.create_user("both@example.com", "password1")
    linked = store.upsert_oauth_user("google", "sub-9", "both@example.com", True)
    assert linked["id"] == local["id"]
    # Password login still works after linking.
    assert store.authenticate("both@example.com", "password1")["id"] == local["id"]


def test_refuses_link_when_email_unverified(store):
    store.create_user("victim@example.com", "password1")
    # An attacker sets the victim's address as an *unverified* email at the
    # provider; linking would hand them the account.
    with pytest.raises(store.OAuthLinkRefusedError):
        store.upsert_oauth_user("github", "attacker-1", "victim@example.com", False)


def test_unverified_email_is_fine_for_a_brand_new_account(store):
    user = store.upsert_oauth_user("github", "gh-2", "fresh@example.com", False)
    assert user["email"] == "fresh@example.com"
    assert user["email_verified"] is False  # no collision, but not verified either


def test_refuses_when_provider_gives_no_email(store):
    with pytest.raises(store.OAuthLinkRefusedError):
        store.upsert_oauth_user("github", "gh-3", "", False)


def test_system_user_cannot_be_claimed(store):
    store.ensure_system_user()
    from models.user import SYSTEM_USER_EMAIL
    with pytest.raises(store.OAuthLinkRefusedError):
        store.upsert_oauth_user("google", "evil-1", SYSTEM_USER_EMAIL, True)


def test_missing_provider_id_rejected(store):
    with pytest.raises(ValueError):
        store.upsert_oauth_user("google", "", "x@example.com", True)


def test_oauth_user_can_hold_a_session(store):
    user = store.upsert_oauth_user("google", "sub-session", "sess@example.com", True)
    token = store.create_session(user["id"])
    assert store.resolve_session(token)["id"] == user["id"]
