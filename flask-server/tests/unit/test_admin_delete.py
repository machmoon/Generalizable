"""Admin-initiated account deletion: the guards, and undoing it.

The guards are the reason this file exists. Deleting an account is another way
of removing an admin, so it can strand an install with nobody able to grant
anything — the same failure role_store.revoke already refuses. Everything else
here is a column write.

Store-level, matching test_role_store.py: the endpoint layer adds the role check
and the status codes, and neither is where the interesting rules live.
"""

import importlib

import pytest


@pytest.fixture()
def stores(tmp_path, monkeypatch):
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'admin.db'}")
    monkeypatch.delenv("ADMIN_EMAILS", raising=False)

    import constants
    importlib.reload(constants)
    import models.engine as engine
    importlib.reload(engine)
    import services.auth_store as auth_store
    importlib.reload(auth_store)
    import services.role_store as role_store
    importlib.reload(role_store)

    engine.reset_engine_for_tests()
    engine.create_all()
    auth_store.ensure_system_user()

    yield auth_store, role_store
    engine.reset_engine_for_tests()


@pytest.fixture()
def make_user():
    def _make(email):
        from services import auth_store
        return auth_store.create_user(email, "password1")["id"]
    return _make


# ---- the guards ------------------------------------------------------------

def test_an_ordinary_account_can_be_deleted(stores, make_user):
    _, role_store = stores
    admin, victim = make_user("admin@b.com"), make_user("someone@b.com")
    role_store.grant(admin, role_store.ROLE_ADMIN)

    role_store.guard_deletion(victim, acting_user_id=admin)  # does not raise


def test_you_cannot_delete_yourself_from_here(stores, make_user):
    """The account page still lets you leave; this button sits in a row of other
    people, and "delete" reading as *that* person while doing *you* is exactly
    the misfire the confirmation exists to prevent."""
    _, role_store = stores
    admin = make_user("admin@b.com")
    role_store.grant(admin, role_store.ROLE_ADMIN)

    with pytest.raises(role_store.RoleError) as e:
        role_store.guard_deletion(admin, acting_user_id=admin)
    assert e.value.reason == role_store.SELF_DELETE


def test_the_last_admin_cannot_be_deleted(stores, make_user):
    _, role_store = stores
    first, second = make_user("one@b.com"), make_user("two@b.com")
    role_store.grant(first, role_store.ROLE_ADMIN)

    # `second` is not an admin, so `first` is the only one left.
    with pytest.raises(role_store.RoleError) as e:
        role_store.guard_deletion(first, acting_user_id=second)
    assert e.value.reason == role_store.LAST_ADMIN


def test_an_admin_can_be_deleted_once_there_is_another(stores, make_user):
    _, role_store = stores
    first, second = make_user("one@b.com"), make_user("two@b.com")
    role_store.grant(first, role_store.ROLE_ADMIN)
    role_store.grant(second, role_store.ROLE_ADMIN)

    role_store.guard_deletion(first, acting_user_id=second)  # does not raise


# ---- deleting and undoing --------------------------------------------------

def test_deleting_signs_them_out_and_locks_them_out(stores, make_user):
    auth_store, _ = stores
    victim = make_user("someone@b.com")
    live = auth_store.create_session(victim)
    assert auth_store.resolve_session(live) is not None

    assert auth_store.request_deletion(victim) is not None
    assert auth_store.resolve_session(live) is None
    assert auth_store.authenticate("someone@b.com", "password1") is not None  # signing in undoes it


def test_restore_makes_the_account_usable_again(stores, make_user):
    auth_store, _ = stores
    victim = make_user("someone@b.com")
    auth_store.request_deletion(victim)

    restored = auth_store.cancel_deletion(victim)
    assert restored is not None and restored["id"] == victim

    # A fresh session resolves again, which is what "usable" means here.
    assert auth_store.resolve_session(auth_store.create_session(victim)) is not None


def test_restore_refuses_once_the_window_has_closed(stores, make_user):
    """Past the grace period the account is treated as gone even if the purge
    hasn't run yet, so an admin can't quietly resurrect one."""
    auth_store, _ = stores
    from datetime import timedelta
    from models.engine import session_scope
    from models.job import utcnow
    from models.user import User

    victim = make_user("someone@b.com")
    auth_store.request_deletion(victim)
    with session_scope() as s:
        s.get(User, victim).deletion_requested_at = (
            utcnow() - timedelta(days=auth_store.DELETION_GRACE_DAYS + 1)
        )

    assert auth_store.cancel_deletion(victim) is None


def test_restore_refuses_an_unknown_account(stores):
    auth_store, _ = stores
    assert auth_store.cancel_deletion("no-such-id") is None


def test_the_system_account_is_not_deletable(stores):
    auth_store, _ = stores
    from models.user import SYSTEM_USER_ID
    assert auth_store.request_deletion(SYSTEM_USER_ID) is None
    assert auth_store.cancel_deletion(SYSTEM_USER_ID) is None


# ---- what the admin list shows ---------------------------------------------

def test_the_account_list_reports_a_pending_deletion(stores, make_user):
    auth_store, role_store = stores
    victim = make_user("someone@b.com")
    make_user("fine@b.com")
    auth_store.request_deletion(victim)

    by_email = {p["email"]: p for p in role_store.search_people()["people"]}
    assert by_email["someone@b.com"]["deletion_requested_at"] is not None
    assert by_email["fine@b.com"]["deletion_requested_at"] is None
