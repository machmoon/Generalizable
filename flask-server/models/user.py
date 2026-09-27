"""User accounts.

Email/password is the only auth method in this phase; password_hash is nullable
so OAuth-only users (added later) can exist without one. A single reserved
"system" user owns legacy/imported jobs, so job.user_id can be NOT NULL without
dropping pre-account job history.

Deletion is a two-step: ``deletion_requested_at`` marks the account for removal
and immediately makes it unusable, but the row survives for a grace period so
signing back in can undo it. Only ``auth_store.purge_expired_deletions`` does
the irreversible part.
"""

from datetime import datetime

from sqlalchemy import Boolean, DateTime, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import db
from models.job import utcnow

# Fixed id for the reserved account that owns legacy/imported jobs. Not a real
# login (no password, is_system=True).
SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000"
SYSTEM_USER_EMAIL = "system@bodymaps.local"


class User(db.Model):
    __tablename__ = "user_account"  # "user" is reserved in some DBs; be explicit.

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    # Stored lower-cased + trimmed; unique so an email maps to one account.
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    # Nullable: OAuth-only users (later) have no password.
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # Display name the user chose. Nullable because accounts created before this
    # column existed have none — the client falls back to the email's local part.
    name: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # Billing plan id (services.plan_store.PLAN_IDS). Everyone starts on "free";
    # nothing is charged, but the limits attached to it are enforced for real.
    plan: Mapped[str] = mapped_column(String(16), nullable=False, default="free",
                                      server_default="free")
    # Self-reported patient/clinician/researcher/student. Gates nothing — it is
    # here so activity can be grouped by it. Nullable because "not set" is the
    # honest answer for anyone who never picked one.
    account_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    # Verified-researcher profile: organization/institution, occupation, and a
    # line about their work. Free text, filled in by the user; with a verified
    # email these qualify the account for the higher scan limit (the check
    # lives in services.plan_store). NULL = not provided.
    organization: Mapped[str | None] = mapped_column(String(200), nullable=True)
    occupation: Mapped[str | None] = mapped_column(String(120), nullable=True)
    role_description: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    # Set when the user asks to delete their account. Non-null means the account
    # is scheduled for removal: it can't be used, but signing back in within the
    # grace window clears this and restores it.
    deletion_requested_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # The reserved legacy owner; excluded from normal auth.
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)

    sessions: Mapped[list["AuthSession"]] = relationship(  # noqa: F821
        back_populates="user", cascade="all, delete-orphan"
    )

    def to_public_dict(self) -> dict:
        """Client-safe view — never includes the password hash."""
        return {
            "id": self.id,
            "email": self.email,
            "name": self.name,
            "plan": self.plan or "free",
            "account_type": self.account_type,
            "organization": self.organization,
            "occupation": self.occupation,
            "role_description": self.role_description,
            "email_verified": self.email_verified_at is not None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }

    def __repr__(self) -> str:
        return f"<User {self.email}{' (system)' if self.is_system else ''}>"
