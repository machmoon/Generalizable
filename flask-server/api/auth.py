"""Request-side auth: read the session cookie, expose the current user, and a
guard for endpoints that require login.

Cookie: httponly (JS can't read it), SameSite=Lax (sent on top-level navigation,
blocked on cross-site POST — the app is same-origin in prod so this is enough),
Secure in production (HTTPS only). Set SESSION_COOKIE_SECURE=true on the server.
"""

import os
from functools import wraps

from flask import g, jsonify, request

from services import auth_store, role_store

COOKIE_NAME = "bm_session"
_COOKIE_MAX_AGE = auth_store.SESSION_TTL_DAYS * 24 * 3600
_COOKIE_SECURE = os.environ.get("SESSION_COOKIE_SECURE", "false").lower() == "true"


def current_user() -> dict | None:
    """The logged-in user's public dict, or None. Cached per request on flask.g."""
    if "current_user" in g:
        return g.current_user
    user = auth_store.resolve_session(request.cookies.get(COOKIE_NAME))
    g.current_user = user
    return user


def current_roles() -> list[str]:
    """Roles held by the logged-in user, or []. Cached per request like the user,
    so a handler that checks a role and then reports it doesn't query twice."""
    if "current_roles" in g:
        return g.current_roles
    user = current_user()
    g.current_roles = role_store.roles_for(user["id"]) if user else []
    return g.current_roles


def require_auth(fn):
    """Endpoint decorator: 401 unless a valid session is present. On success the
    user is available via current_user()."""
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if current_user() is None:
            return jsonify({"error": "Authentication required"}), 401
        return fn(*args, **kwargs)
    return wrapper


def refuse_unless_role(role: str):
    """None when the caller holds `role`, else the response to return.

    Separate from the decorator because a handler sometimes has to run its own
    check first — the analytics endpoints 404 when the dashboard is switched off,
    and that has to answer before any 401/403 reveals the endpoint exists.

    Distinct statuses on purpose — the client can tell "sign in" apart from "you
    are signed in and this isn't yours", and only the first is worth prompting
    the auth modal for.
    """
    if current_user() is None:
        return jsonify({"error": "Authentication required"}), 401
    if role not in current_roles():
        return jsonify({"error": "You don't have access to this."}), 403
    return None


def require_role(role: str):
    """Endpoint decorator wrapping refuse_unless_role for the common case."""
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            return refuse_unless_role(role) or fn(*args, **kwargs)
        return wrapper
    return decorator


def set_session_cookie(response, raw_token: str):
    response.set_cookie(
        COOKIE_NAME, raw_token,
        max_age=_COOKIE_MAX_AGE, httponly=True, secure=_COOKIE_SECURE,
        samesite="Lax", path="/",
    )
    return response


def clear_session_cookie(response):
    response.delete_cookie(COOKIE_NAME, path="/")
    return response
