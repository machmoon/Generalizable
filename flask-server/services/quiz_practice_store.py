"""Filesystem-backed untimed solo practice using frozen server-side quiz packs."""

from __future__ import annotations

import hashlib
import hmac
import gzip
import json
import os
import secrets
import shutil
import tempfile
import threading
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

try:
    import fcntl
except ImportError:  # pragma: no cover
    fcntl = None

import nibabel as nib
import numpy as np

from services.live_quiz import (
    QuizPackError,
    QuizPackRegistry,
    choice_ids,
    consistency_for,
    correct_choice,
    get_registry,
    public_pack,
    reveal_for,
)
from services.quiz_telemetry import QuizTelemetry


ATTEMPT_TTL = timedelta(hours=24)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    except Exception:
        Path(temporary).unlink(missing_ok=True)
        raise


class QuizPracticeError(RuntimeError):
    status_code = 400
    code = "invalid_quiz_practice_request"


class QuizPracticeUnauthorized(QuizPracticeError):
    status_code = 401
    code = "invalid_quiz_attempt_key"


class QuizPracticeNotFound(QuizPracticeError):
    status_code = 404
    code = "quiz_attempt_not_found"


class QuizPracticeExpired(QuizPracticeError):
    status_code = 410
    code = "quiz_attempt_expired"


class QuizPracticeStore:
    def __init__(
        self,
        sessions_dir: str | os.PathLike[str],
        pants_path: str | os.PathLike[str] | None,
        *,
        registry: QuizPackRegistry | None = None,
        now: Callable[[], datetime] = utcnow,
    ) -> None:
        self.root = Path(sessions_dir).resolve() / "quiz_practice"
        self.root.mkdir(parents=True, exist_ok=True)
        self.pants_path = Path(pants_path).resolve() if pants_path else None
        self.registry = registry or get_registry()
        self._now = now
        self.telemetry = QuizTelemetry(sessions_dir)
        self._locks: dict[str, threading.RLock] = {}
        self._locks_guard = threading.Lock()

    def _dir(self, attempt_id: str) -> Path:
        try:
            canonical = str(uuid.UUID(attempt_id))
        except (ValueError, AttributeError) as exc:
            raise QuizPracticeNotFound("Quiz attempt not found") from exc
        if canonical != attempt_id.lower():
            raise QuizPracticeNotFound("Quiz attempt not found")
        return self.root / canonical

    def _read(self, path: Path) -> dict[str, Any]:
        try:
            with path.open("r", encoding="utf-8") as stream:
                value = json.load(stream)
        except (OSError, json.JSONDecodeError) as exc:
            raise QuizPracticeNotFound("Quiz attempt not found") from exc
        if not isinstance(value, dict):
            raise QuizPracticeNotFound("Quiz attempt not found")
        return value

    @contextmanager
    def _locked(self, attempt_id: str):
        directory = self._dir(attempt_id)
        with self._locks_guard:
            lock = self._locks.setdefault(attempt_id, threading.RLock())
        with lock:
            if not (directory / "attempt.json").is_file():
                raise QuizPracticeNotFound("Quiz attempt not found")
            with (directory / ".lock").open("a+b") as lock_file:
                if fcntl is not None:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                try:
                    yield directory
                finally:
                    if fcntl is not None:
                        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _authorized(self, attempt_id: str, key: str) -> tuple[Path, dict[str, Any], dict[str, Any]]:
        directory = self._dir(attempt_id)
        attempt = self._read(directory / "attempt.json")
        if not key or not hmac.compare_digest(_hash(key), attempt.get("key_hash", "")):
            raise QuizPracticeUnauthorized("Invalid quiz attempt key")
        if _parse(attempt["expires_at"]) <= self._now():
            raise QuizPracticeExpired("Quiz attempt expired")
        pack = self._read(directory / "quiz_pack.json")
        return directory, attempt, pack

    def start(self, pack_id: str) -> tuple[dict[str, Any], str]:
        try:
            pack = self.registry.get(pack_id)
        except QuizPackError as exc:
            raise QuizPracticeError(str(exc)) from exc
        attempt_id = str(uuid.uuid4())
        key = secrets.token_urlsafe(32)
        started = self._now()
        attempt = {
            "attempt_id": attempt_id,
            "pack_id": pack["pack_id"],
            "pack_version": pack["version"],
            "case_id": pack["case_id"],
            "status": "started",
            "started_at": _iso(started),
            "expires_at": _iso(started + ATTEMPT_TTL),
            "key_hash": _hash(key),
        }
        directory = self._dir(attempt_id)
        directory.mkdir(parents=True, exist_ok=False)
        pack_path = directory / "quiz_pack.json"
        _atomic_json(pack_path, pack)
        pack_path.chmod(0o600)
        # attempt.json is readiness marker for this multi-file attempt.
        _atomic_json(directory / "attempt.json", attempt)
        self.telemetry.record(
            "pack_started",
            pack_id=pack["pack_id"],
            case_id=pack["case_id"],
            mode="solo",
        )
        return {
            "attempt_id": attempt_id,
            "pack": public_pack(pack, choice_seed=attempt_id),
            "status": "started",
            "started_at": attempt["started_at"],
            "expires_at": attempt["expires_at"],
        }, key

    def submit(self, attempt_id: str, key: str, answers: Any) -> dict[str, Any]:
        with self._locked(attempt_id):
            directory, attempt, pack = self._authorized(attempt_id, key)
            if attempt.get("status") != "started":
                raise QuizPracticeError("Quiz attempt is already submitted")
            if not isinstance(answers, dict):
                raise QuizPracticeError("answers must be an object")
            expected = {question["id"] for question in pack["questions"]}
            if set(answers) != expected or not all(isinstance(value, str) for value in answers.values()):
                raise QuizPracticeError("Submit exactly one answer for each quiz question")
            for question_id, choice_id in answers.items():
                if choice_id not in choice_ids(pack, question_id):
                    raise QuizPracticeError(f"Invalid answer choice for {question_id}")
            score = sum(
                answers[question["id"]] == correct_choice(pack, question["id"])
                for question in pack["questions"]
            )
            reveals = [
                reveal_for(pack, question["id"], {"solo": {"choice_id": answers[question["id"]]}})
                for question in pack["questions"]
            ]
            result = {
                "attempt_id": attempt_id,
                "pack_id": pack["pack_id"],
                "pack_version": pack["version"],
                "case_id": pack["case_id"],
                "status": "completed",
                "completed_at": _iso(self._now()),
                "score": score,
                "max_score": len(pack["questions"]),
                "answers": dict(answers),
                "consistency": consistency_for(answers, pack),
                "reveals": reveals,
            }
            result_path = directory / "result.json"
            _atomic_json(result_path, result)
            result_path.chmod(0o600)
            attempt["status"] = "completed"
            attempt["completed_at"] = result["completed_at"]
            _atomic_json(directory / "attempt.json", attempt)
        self.telemetry.record(
            "pack_completed",
            pack_id=pack["pack_id"],
            case_id=pack["case_id"],
            mode="solo",
            payload={"score": score, "max_score": len(pack["questions"])},
        )
        for reveal in reveals:
            self.telemetry.record(
                "answer_distribution",
                pack_id=pack["pack_id"],
                case_id=pack["case_id"],
                mode="solo",
                payload={"question_id": reveal["question_id"], "distribution": reveal["distribution"]},
            )
        return result

    def cleanup_expired(self) -> list[str]:
        removed: list[str] = []
        for child in list(self.root.iterdir()):
            if not child.is_dir():
                continue
            try:
                attempt_id = str(uuid.UUID(child.name))
            except ValueError:
                shutil.rmtree(child, ignore_errors=True)
                continue
            tombstone = self.root / f".expired-{attempt_id}"
            try:
                with self._locked(attempt_id) as directory:
                    attempt = self._read(directory / "attempt.json")
                    if _parse(attempt["expires_at"]) > self._now():
                        continue
                    os.replace(directory, tombstone)
            except (QuizPracticeError, KeyError, TypeError, ValueError, OSError):
                continue
            shutil.rmtree(tombstone, ignore_errors=True)
            removed.append(attempt_id)
        return removed

    def result(self, attempt_id: str, key: str) -> dict[str, Any]:
        directory, attempt, _ = self._authorized(attempt_id, key)
        if attempt.get("status") != "completed":
            raise QuizPracticeError("Quiz attempt has not been submitted")
        return self._read(directory / "result.json")

    def reveal_segmentation(self, attempt_id: str, key: str) -> bytes:
        _, attempt, pack = self._authorized(attempt_id, key)
        if attempt.get("status") != "completed":
            error = QuizPracticeError("Quiz reveal is locked until submission")
            error.status_code = 403
            error.code = "quiz_reveal_locked"
            raise error
        try:
            if self.pants_path is None:
                raise QuizPracticeError("PANTS_PATH is not configured")
            dataset_id = str(pack["provenance"]["dataset_id"])
            mask_path = self.pants_path / "mask_only" / dataset_id / "combined_labels.nii.gz"
            if not mask_path.is_file():
                raise QuizPracticeError("Quiz segmentation is unavailable")
            image = nib.load(str(mask_path))
            source = np.asanyarray(image.dataobj)
            descriptor = pack["ground_truth"]["reveal_mask"]
            labels = [int(value) for value in descriptor.get("source_labels") or []]
            selected = np.isin(source, labels) if labels else np.zeros(source.shape, dtype=bool)
            if pack["ground_truth"]["lesion_present"] and not np.any(selected):
                raise QuizPracticeError("Quiz reveal mask is empty")
            output_data = np.zeros(source.shape, dtype=np.uint8)
            output_data[selected] = int(descriptor.get("output_label", 1))
            output = nib.Nifti1Image(output_data, image.affine, header=image.header.copy())
            output.set_data_dtype(np.uint8)
            return gzip.compress(output.to_bytes(), compresslevel=1)
        except Exception:
            self.telemetry.record(
                "reveal_failure",
                pack_id=pack["pack_id"],
                case_id=pack["case_id"],
                mode="solo",
            )
            raise
