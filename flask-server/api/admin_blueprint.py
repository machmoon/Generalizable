"""Admin: the account list, granting/revoking roles, and closing an account.

Routes (registered under <BASE_PATH>/api), all admin-only:
  GET    /admin/people?q=&limit=&offset=   -> accounts + their roles
  POST   /admin/people/<user_id>/roles     {role} -> grant
  DELETE /admin/people/<user_id>/roles/<role>     -> revoke
  DELETE /admin/people/<user_id>                  -> schedule for deletion
  POST   /admin/people/<user_id>/restore          -> undo a scheduled deletion

Deliberately NOT behind ANALYTICS_DASHBOARD. That flag exists because the usage
endpoints report on how every account behaves and it should take a deliberate
act to serve that anywhere; role management is ordinary account administration
and has to work on a normal deploy, or the flag becomes the thing standing
between an admin and granting someone access.

These endpoints do expose every account's email to an admin. That is the point
of the page — an admin has to be able to find the person they're granting a role
to — but it is why the only way in is require_role("admin").
"""

from flask import Blueprint, jsonify, request

from api.auth import current_user, require_role
from services import auth_store, role_store

admin_blueprint = Blueprint("admin", __name__)


@admin_blueprint.route("/admin/people", methods=["GET"])
@require_role(role_store.ROLE_ADMIN)
def people():
    """Accounts, newest first, optionally filtered by ?q= against email/name."""
    try:
        limit = int(request.args.get("limit") or 25)
        offset = int(request.args.get("offset") or 0)
    except ValueError:
        return jsonify({"error": "limit and offset must be numbers"}), 400

    result = role_store.search_people(
        query=request.args.get("q") or None, limit=limit, offset=offset,
    )
    # So the UI can render the toggles from the server's vocabulary rather than
    # keeping a second copy of the role list.
    result["roles"] = sorted(role_store.ROLES)
    return jsonify(result), 200


@admin_blueprint.route("/admin/people/<user_id>/roles", methods=["POST"])
@require_role(role_store.ROLE_ADMIN)
def grant_role(user_id: str):
    raw_body = request.get_json(silent=True)
    body = raw_body if isinstance(raw_body, dict) else {}
    role = body.get("role") or ""
    try:
        roles = role_store.grant(user_id, role, granted_by=current_user()["id"])
    except LookupError:
        return jsonify({"error": "Account not found"}), 404
    except ValueError:
        return jsonify({"error": "Unknown role"}), 400
    return jsonify({"user_id": user_id, "roles": roles}), 200


@admin_blueprint.route("/admin/people/<user_id>/roles/<role>", methods=["DELETE"])
@require_role(role_store.ROLE_ADMIN)
def revoke_role(user_id: str, role: str):
    try:
        roles = role_store.revoke(user_id, role, acting_user_id=current_user()["id"])
    except role_store.RoleError as e:
        # 409: the request is well-formed and the caller is allowed to make it —
        # the state of the world is what refuses it.
        return jsonify({"error": str(e), "reason": e.reason}), 409
    except ValueError:
        return jsonify({"error": "Unknown role"}), 400
    return jsonify({"user_id": user_id, "roles": roles}), 200


@admin_blueprint.route("/admin/people/<user_id>", methods=["DELETE"])
@require_role(role_store.ROLE_ADMIN)
def delete_account(user_id: str):
    """Close someone's account.

    The same reversible path the account owner gets from their own privacy
    settings: unusable and signed out everywhere immediately, but the row and
    the data survive DELETION_GRACE_DAYS. An admin acting on a report, or
    cleaning up a duplicate, is exactly the case where being able to change
    your mind matters — and unlike the owner, they can't sign back in to undo
    it, which is why /restore below exists.
    """
    try:
        role_store.guard_deletion(user_id, acting_user_id=current_user()["id"])
    except role_store.RoleError as e:
        # 409, same as a refused revoke: well-formed request, allowed caller,
        # and the state of the world is what refuses it.
        return jsonify({"error": str(e), "reason": e.reason}), 409

    result = auth_store.request_deletion(user_id)
    if result is None:
        return jsonify({"error": "Account not found"}), 404
    return jsonify({"user_id": user_id, **result}), 200


@admin_blueprint.route("/admin/people/<user_id>/restore", methods=["POST"])
@require_role(role_store.ROLE_ADMIN)
def restore_account(user_id: str):
    """Undo a scheduled deletion, while the grace window is still open."""
    user = auth_store.cancel_deletion(user_id)
    if user is None:
        return jsonify({
            "error": "That account is gone, or its 30-day window has already closed."
        }), 404
    return jsonify({"user_id": user_id, "deletion_requested_at": None}), 200
