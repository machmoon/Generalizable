"""Roles held by an account.

A row per (user, role) rather than a column per role on ``user_account``: the
set of roles is expected to grow, and a table means adding one costs no
migration. ``admin`` is the only one today — see ``services.role_store.ROLES``,
which is the list that is actually enforced.

``granted_by`` records which admin handed the role out. Roles are granted by
other admins through the account UI, so "who gave this person access" is a
question that will be asked; keeping it here makes it answerable. It is nullable
because the bootstrap admins from ``ADMIN_EMAILS`` are granted by the server
itself, not by a person.

SET NULL rather than CASCADE on ``granted_by``: deleting the admin who granted a
role must not silently strip the role from everyone they onboarded.
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from models.base import db
from models.job import utcnow


class UserRole(db.Model):
    __tablename__ = "user_role"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    # CASCADE: a purged account should not leave its grants behind.
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("user_account.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    role: Mapped[str] = mapped_column(String(32), nullable=False, index=True)
    granted_by: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("user_account.id", ondelete="SET NULL"),
        nullable=True,
    )
    granted_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)

    __table_args__ = (
        # Granting a role twice is a no-op, not a second row.
        UniqueConstraint("user_id", "role", name="uq_user_role_user_id_role"),
    )

    def __repr__(self) -> str:
        return f"<UserRole {self.role} user={self.user_id}>"
