"""Privacy-minimized append-only quiz telemetry."""

from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None


ALLOWED_EVENTS = {
    "pack_started",
    "pack_completed",
    "answer_distribution",
    "reveal_failure",
    "content_report",
}
ALLOWED_REPORT_CATEGORIES = {
    "incorrect_answer",
    "incorrect_location",
    "incorrect_measurement",
    "incorrect_reveal",
    "unclear_question",
    "other",
}
ALLOWED_MODES = {"solo", "race", "unspecified"}
QUESTION_IDS = {"organ", "presence", "location", "report_finding", "conclusion"}


def _validated_payload(event: str, payload: dict[str, Any] | None) -> dict[str, Any]:
    value = payload or {}
    if not isinstance(value, dict):
        raise ValueError("Quiz telemetry payload must be an object")
    if event in {"pack_started", "reveal_failure"}:
        allowed: set[str] = set()
    elif event == "pack_completed":
        allowed = {"score", "max_score"}
    elif event == "answer_distribution":
        allowed = {"question_id", "distribution"}
    else:
        allowed = {"category"}
    if set(value) - allowed:
        raise ValueError("Unsupported quiz telemetry payload field")
    if event == "pack_completed" and value:
        if not all(isinstance(value.get(key), int) and value[key] >= 0 for key in allowed):
            raise ValueError("Quiz completion telemetry needs non-negative integer scores")
    elif event == "answer_distribution":
        distribution = value.get("distribution")
        if value.get("question_id") not in QUESTION_IDS or not isinstance(distribution, dict):
            raise ValueError("Quiz answer-distribution telemetry is invalid")
        if len(distribution) > 32 or not all(
            isinstance(key, str) and 0 < len(key) <= 64
            and isinstance(count, int) and count >= 0
            for key, count in distribution.items()
        ):
            raise ValueError("Quiz answer-distribution telemetry is invalid")
    elif event == "content_report" and value.get("category") not in ALLOWED_REPORT_CATEGORIES:
        raise ValueError("Quiz content-report telemetry category is invalid")
    return value


class QuizTelemetry:
    def __init__(self, sessions_dir: str | os.PathLike[str]) -> None:
        self.path = Path(sessions_dir).resolve() / "quiz_telemetry.jsonl"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def record(
        self,
        event: str,
        *,
        pack_id: str,
        case_id: str,
        mode: str,
        payload: dict[str, Any] | None = None,
    ) -> str:
        if event not in ALLOWED_EVENTS:
            raise ValueError("Unsupported quiz telemetry event")
        if mode not in ALLOWED_MODES:
            raise ValueError("Unsupported quiz telemetry mode")
        safe_payload = _validated_payload(event, payload)
        event_id = str(uuid.uuid4())
        record = {
            "event_id": event_id,
            "event": event,
            "recorded_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "pack_id": str(pack_id),
            "case_id": str(case_id),
            "mode": str(mode),
            "payload": safe_payload,
        }
        encoded = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        with self._lock:
            with self.path.open("a", encoding="utf-8") as stream:
                if fcntl is not None:
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
                try:
                    stream.write(encoded)
                    stream.flush()
                    os.fsync(stream.fileno())
                    self.path.chmod(0o600)
                finally:
                    if fcntl is not None:
                        fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        return event_id
