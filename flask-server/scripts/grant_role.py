#!/usr/bin/env python3
"""Grant or revoke a role from the command line.

The escape hatch for the case the UI can't cover: the very first admin, when
ADMIN_EMAILS wasn't set (or the account didn't exist yet at boot).

    python flask-server/scripts/grant_role.py --email you@example.com --role admin
    python flask-server/scripts/grant_role.py --email them@example.com --role admin --revoke
    python flask-server/scripts/grant_role.py --list

Talks to the same DATABASE_URL the server uses, so run it with the same env
(a .env next to app.py is loaded automatically).
"""

import argparse
import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from dotenv import load_dotenv

load_dotenv(dotenv_path=os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"
))

from sqlalchemy import select  # noqa: E402

from models.engine import session_scope  # noqa: E402
from models.user import User  # noqa: E402
from services import role_store  # noqa: E402


def _find_user_id(email: str) -> str | None:
    with session_scope() as s:
        return s.execute(
            select(User.id).where(User.email == email.strip().lower())
        ).scalar_one_or_none()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--email", help="the account to change")
    parser.add_argument("--role", choices=sorted(role_store.ROLES))
    parser.add_argument("--revoke", action="store_true",
                        help="take the role away instead of granting it")
    parser.add_argument("--list", action="store_true", dest="list_roles",
                        help="list every account that holds a role, and exit")
    args = parser.parse_args()

    if args.list_roles:
        result = role_store.search_people(limit=100)
        held = [p for p in result["people"] if p["roles"]]
        if not held:
            print("Nobody holds a role yet.")
        for person in held:
            print(f"{person['email']:<40} {', '.join(person['roles'])}")
        return 0

    if not args.email or not args.role:
        parser.error("--email and --role are required (or use --list)")

    user_id = _find_user_id(args.email)
    if user_id is None:
        print(f"No account with email {args.email!r}. They need to sign up first.",
              file=sys.stderr)
        return 1

    try:
        if args.revoke:
            # No acting user, so the "can't demote yourself" rule doesn't apply
            # here. The last-admin guard still does: it refuses, and says to
            # promote someone else first.
            roles = role_store.revoke(user_id, args.role)
            print(f"Revoked {args.role} from {args.email}.")
        else:
            roles = role_store.grant(user_id, args.role)
            print(f"Granted {args.role} to {args.email}.")
    except role_store.RoleError as e:
        print(str(e), file=sys.stderr)
        return 1

    print(f"Now holds: {', '.join(roles) or 'no roles'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
