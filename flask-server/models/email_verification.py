"""One-time tokens for "verify your email address".

Same shape as ``password_reset`` and for the same reasons: the raw token goes
out in an email and only its SHA-256 is stored, ``used_at`` makes it
single-use, and a newer request supersedes the old one.

The window is longer (``auth_store.VERIFY_TTL_MINUTES``, a day) than a reset
token's hour: a reset link guards an account takeover, while this one can only
ever mark the address it was sent to as verified - the worst a leaked link can
do is finish the job it was sent to do.
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from models.base import db
from models.job import utcnow


class EmailVerificationToken(db.Model):
    __tablename__ = "email_verification_token"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    # CASCADE: a purged account leaves no redeemable links behind.
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("user_account.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    # SHA-256 of the raw token from the emailed link (hex).
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    # Set on redemption or when a newer request supersedes it.
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    def is_redeemable(self, now: datetime | None = None) -> bool:
        now = now or utcnow()
        return self.used_at is None and self.expires_at > now

    def __repr__(self) -> str:
        return f"<EmailVerificationToken user={self.user_id} exp={self.expires_at.isoformat()}>"
