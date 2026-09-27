"""Trusted client addressing and cross-process persistent request quotas."""

from __future__ import annotations

import hashlib
import ipaddress
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Mapping


DEFAULT_TRUSTED_PROXIES = "127.0.0.1/32,::1/128"
MAX_RATE_ROWS = 100_000


def trusted_client_ip(remote_addr: str | None, headers: Mapping[str, str]) -> str:
    remote_text = (remote_addr or "").strip()
    try:
        remote = ipaddress.ip_address(remote_text)
    except ValueError:
        return "unknown"
    networks = []
    for value in os.getenv("BODYMAPS_TRUSTED_PROXY_CIDRS", DEFAULT_TRUSTED_PROXIES).split(","):
        try:
            networks.append(ipaddress.ip_network(value.strip(), strict=False))
        except ValueError:
            continue
    if any(remote in network for network in networks):
        forwarded = (headers.get("X-Real-IP") or headers.get("X-Forwarded-For") or "").strip()
        if "," not in forwarded:
            try:
                return str(ipaddress.ip_address(forwarded))
            except ValueError:
                pass
    return str(remote)


class PersistentRateLimiter:
    def __init__(self, path: str | os.PathLike[str]) -> None:
        self.path = Path(path).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_lock = threading.Lock()
        self._initialized = False

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5)
        connection.execute("PRAGMA busy_timeout=5000")
        return connection

    def _ensure(self) -> None:
        if self._initialized:
            return
        with self._init_lock:
            if self._initialized:
                return
            with self._connect() as connection:
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute(
                    "CREATE TABLE IF NOT EXISTS attempts ("
                    "namespace TEXT NOT NULL, identity_hash TEXT NOT NULL, created_at REAL NOT NULL)"
                )
                connection.execute(
                    "CREATE INDEX IF NOT EXISTS attempts_lookup "
                    "ON attempts(namespace, identity_hash, created_at)"
                )
            self._initialized = True

    def allow(self, namespace: str, identity: str, limit: int, window_seconds: float) -> bool:
        self._ensure()
        now = time.time()
        identity_hash = hashlib.sha256(identity.encode("utf-8")).hexdigest()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("DELETE FROM attempts WHERE created_at < ?", (now - 86_400,))
            count = connection.execute(
                "SELECT COUNT(*) FROM attempts "
                "WHERE namespace = ? AND identity_hash = ? AND created_at >= ?",
                (namespace, identity_hash, now - window_seconds),
            ).fetchone()[0]
            if int(count) >= limit:
                connection.rollback()
                return False
            connection.execute(
                "INSERT INTO attempts(namespace, identity_hash, created_at) VALUES (?, ?, ?)",
                (namespace, identity_hash, now),
            )
            total = int(connection.execute("SELECT COUNT(*) FROM attempts").fetchone()[0])
            if total > MAX_RATE_ROWS:
                connection.execute(
                    "DELETE FROM attempts WHERE rowid IN ("
                    "SELECT rowid FROM attempts ORDER BY created_at ASC LIMIT ?) ",
                    (total - MAX_RATE_ROWS,),
                )
            connection.commit()
        return True
