"""Server-side auth sessions.

The browser holds an opaque random token in an httponly cookie; we store only
its SHA-256 hash, so a DB leak doesn't hand out live sessions. Sessions are
revocable (logout / "sign out everywhere") and expire, which a stateless JWT
can't do without extra machinery.
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import db
from models.job import utcnow


class AuthSession(db.Model):
    __tablename__ = "auth_session"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("user_account.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # SHA-256 of the raw cookie token (hex). Unique so a token maps to one session.
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)

    user: Mapped["User"] = relationship(back_populates="sessions")  # noqa: F821

    def is_active(self, now: datetime | None = None) -> bool:
        now = now or utcnow()
        return self.revoked_at is None and self.expires_at > now

    def __repr__(self) -> str:
        return f"<AuthSession user={self.user_id} exp={self.expires_at.isoformat()}>"
