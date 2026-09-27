"""Outbound email, over SMTP, with stdlib only.

There is exactly one thing to send today (a password reset link), so this is
``smtplib`` and ``email.message`` rather than a dependency. A mail library earns
its place when there are templates, attachments, and bounce handling; none of
that exists here.

**Unconfigured is a supported state, not an error.** With ``SMTP_USER``/
``SMTP_PASSWORD`` unset — local dev, and production until the credentials are
filled in — the message is printed to stdout instead, reset link and all, and
``send`` returns False. That keeps the whole flow exercisable without a mailbox,
and it is the reason a developer can test "forgot password" by reading the
gunicorn log.

**A send failure never propagates.** SMTP is a network call to someone else's
server; it times out, it rate-limits, it rejects credentials. The caller is an
HTTP handler answering a user who asked for a link, and turning "Gmail was slow"
into a 500 tells them nothing they can act on. Every failure is caught, logged,
and reported as False.

Gmail note: ``SMTP_PASSWORD`` must be a 16-character **App Password**, not the
account password. Google stopped accepting account passwords for SMTP, and the
failure mode is an ``SMTPAuthenticationError`` at send time.
"""

import os
import smtplib
import ssl
from email.message import EmailMessage

# Long enough for a slow handshake, short enough that a hung SMTP server doesn't
# hold a request thread for the gunicorn timeout.
TIMEOUT_SECONDS = 10

DEFAULT_HOST = "smtp.gmail.com"
DEFAULT_PORT = 587


def _config() -> dict:
    """Read live rather than at import, matching how the analytics flags are
    handled — a restart is enough to change where mail goes."""
    return {
        "host": os.environ.get("SMTP_HOST") or DEFAULT_HOST,
        "port": int(os.environ.get("SMTP_PORT") or DEFAULT_PORT),
        "user": os.environ.get("SMTP_USER") or "",
        "password": os.environ.get("SMTP_PASSWORD") or "",
        # Defaults to the sending account. A domain that enforces SPF/DKIM will
        # want this set to an address it actually authorises.
        "from_addr": os.environ.get("SMTP_FROM") or os.environ.get("SMTP_USER") or "",
        "starttls": (os.environ.get("SMTP_STARTTLS") or "true").lower() == "true",
    }


def is_configured() -> bool:
    cfg = _config()
    return bool(cfg["user"] and cfg["password"])


def _log_instead(to: str, subject: str, body: str) -> None:
    """The unconfigured path. Deliberately loud and deliberately complete — the
    whole point is that someone can copy the reset link out of the log."""
    print(
        "\n[mail] SMTP is not configured; the message below was NOT sent.\n"
        f"[mail] To: {to}\n"
        f"[mail] Subject: {subject}\n"
        f"[mail] ---\n{body}\n[mail] ---\n",
        flush=True,
    )


def send(to: str, subject: str, body: str, html_body: str | None = None) -> bool:
    """Send one message. True if SMTP accepted it, False in every other case
    (unconfigured, refused, timed out) — never raises."""
    cfg = _config()
    if not (cfg["user"] and cfg["password"]):
        _log_instead(to, subject, body)
        return False

    message = EmailMessage()
    message["From"] = cfg["from_addr"]
    message["To"] = to
    message["Subject"] = subject
    message.set_content(body)
    if html_body:
        message.add_alternative(html_body, subtype="html")

    try:
        with smtplib.SMTP(cfg["host"], cfg["port"], timeout=TIMEOUT_SECONDS) as smtp:
            if cfg["starttls"]:
                smtp.starttls(context=ssl.create_default_context())
            smtp.login(cfg["user"], cfg["password"])
            smtp.send_message(message)
        return True
    except smtplib.SMTPAuthenticationError:
        # By far the most likely misconfiguration, and the least obvious from a
        # generic error, so it gets its own line.
        print(
            "[mail] SMTP rejected the credentials. For Gmail, SMTP_PASSWORD must "
            "be a 16-character App Password, not the account password.",
            flush=True,
        )
        return False
    except Exception as e:
        print(f"[mail] send to {to} failed: {type(e).__name__}: {e}", flush=True)
        return False
