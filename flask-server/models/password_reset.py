"""One-time tokens for "I forgot my password".

Shaped like ``auth_session`` and for the same reason: the raw token goes out in
an email and only its SHA-256 is stored, so a database leak hands out no live
reset links. It differs in two ways that matter.

``used_at`` makes a token single-use. Reset links land in mailboxes, get
forwarded, and sit in browser history; a link that still works after the
password has been changed is a standing key to the account.

The window is short (``auth_store.RESET_TTL_MINUTES``) rather than the fourteen
days a session gets. A session is something the user is actively holding; a
reset token is something sitting unattended in an inbox.

There is no ``revoked_at``. A superseded token is simply marked used — asking
for a second link is the ordinary way to invalidate the first, and one column
answers "can this still be redeemed" for both cases.
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import db
from models.job import utcnow


class PasswordResetToken(db.Model):
    __tablename__ = "password_reset_token"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    # CASCADE: a purged account should not leave redeemable reset links behind.
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("user_account.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    # SHA-256 of the raw token from the emailed link (hex). Unique so a token
    # maps to one request.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    # Set the moment the token is redeemed, or when a newer request supersedes
    # it. Non-null means it can never be used again.
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    def is_redeemable(self, now: datetime | None = None) -> bool:
        now = now or utcnow()
        return self.used_at is None and self.expires_at > now

    def __repr__(self) -> str:
        return f"<PasswordResetToken user={self.user_id} exp={self.expires_at.isoformat()}>"
