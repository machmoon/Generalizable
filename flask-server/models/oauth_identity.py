"""Links a user_account to an external OAuth identity (Google/GitHub).

One user can hold several identities (password + Google + GitHub all on the
same account); each identity is looked up by (provider, provider_user_id) —
never by email alone, since emails can be reassigned or spoofed at the
provider and provider_user_id is the stable, provider-issued identifier.
"""

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from models.base import db
from models.job import utcnow


class OAuthIdentity(db.Model):
    __tablename__ = "oauth_identity"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("user_account.id", ondelete="CASCADE"), nullable=False, index=True
    )
    provider: Mapped[str] = mapped_column(String(20), nullable=False)  # "google" | "github"
    # The provider's stable subject id (Google's "sub", GitHub's numeric user id
    # as a string) — not the email, which can change.
    provider_user_id: Mapped[str] = mapped_column(String(128), nullable=False)
    # Email as reported by the provider at link time; informational only (login
    # is by provider_user_id, not this).
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=utcnow)

    __table_args__ = (
        UniqueConstraint("provider", "provider_user_id", name="uq_oauth_identity_provider_user"),
    )

    def __repr__(self) -> str:
        return f"<OAuthIdentity {self.provider}:{self.provider_user_id} -> user={self.user_id}>"
