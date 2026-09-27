from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from services.request_limits import PersistentRateLimiter, trusted_client_ip


def test_forwarding_headers_are_only_used_from_trusted_proxy(monkeypatch):
    monkeypatch.setenv("BODYMAPS_TRUSTED_PROXY_CIDRS", "127.0.0.1/32")
    assert trusted_client_ip("203.0.113.10", {"X-Forwarded-For": "198.51.100.5"}) == "203.0.113.10"
    assert trusted_client_ip("127.0.0.1", {"X-Real-IP": "198.51.100.5"}) == "198.51.100.5"
    assert trusted_client_ip("127.0.0.1", {"X-Forwarded-For": "198.51.100.5, 203.0.113.2"}) == "127.0.0.1"


def test_persistent_rate_limit_is_shared_across_instances(tmp_path: Path):
    path = tmp_path / "limits.sqlite3"
    first = PersistentRateLimiter(path)
    second = PersistentRateLimiter(path)
    assert first.allow("create", "198.51.100.5", 2, 60) is True
    assert second.allow("create", "198.51.100.5", 2, 60) is True
    assert first.allow("create", "198.51.100.5", 2, 60) is False
    assert second.allow("create", "198.51.100.6", 2, 60) is True
