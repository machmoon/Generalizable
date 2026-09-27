"""Offline case-quality metadata used by search and shuffle ranking."""

from __future__ import annotations

import base64
import hashlib
import json
import os
from io import BytesIO
from typing import Any

import numpy as np
import pandas as pd
from PIL import Image, ImageOps

from services.ollama_client import OllamaInvalidResponse, chat_structured_json


CASE_QUALITY_SCHEMA_VERSION = 1
DETERMINISTIC_DETECTOR_VERSION = "thumbnail-integrity-v1"
VISION_PROMPT_VERSION = "thumbnail-distortion-v1"
VISION_CONFIDENCE_THRESHOLD = 0.80

THUMBNAIL_STATUS_RANK = {
    "undistorted": 0,
    "unknown": 1,
    "distorted": 2,
}

VISION_CLASSIFICATIONS = {"undistorted", "distorted", "uncertain"}
VISION_REASONS = {
    "plausible_anatomical_proportions",
    "horizontal_stretching",
    "vertical_stretching",
    "severe_cropping",
    "rotation_or_orientation_issue",
    "technical_image_failure",
    "insufficient_evidence",
}

VISION_RESULT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "classification": {
            "type": "string",
            "enum": sorted(VISION_CLASSIFICATIONS),
        },
        "confidence": {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
        },
        "reasons": {
            "type": "array",
            "items": {
                "type": "string",
                "enum": sorted(VISION_REASONS),
            },
        },
    },
    "required": ["classification", "confidence", "reasons"],
}

VISION_SYSTEM_PROMPT = """You inspect medical scan thumbnails for display quality only.
Judge visible geometric or technical distortion: horizontal stretching, vertical
stretching, severe crop, wrong orientation, or broken image rendering. Do not diagnose
disease and do not use tumor appearance as a quality signal. Natural anatomy, black
letterboxing, and non-square source images are not automatically distorted. Return
uncertain unless evidence is strong. Return only the requested JSON object."""

VISION_USER_PROMPT = """Classify this thumbnail as undistorted, distorted, or uncertain.
Report confidence from 0 to 1 and select only allowed reason codes."""


def _warn(message: str) -> None:
    print(f"[WARN] Case quality manifest: {message}")


def load_case_quality_manifest(path: str | None) -> dict[str, dict[str, Any]]:
    """Load valid case records from a version-1 manifest without blocking startup."""
    if not path:
        return {}
    if not os.path.exists(path):
        _warn(f"not found at {path}; using metadata-only ranking")
        return {}

    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError) as exc:
        _warn(f"could not read {path}: {exc}; using metadata-only ranking")
        return {}

    if not isinstance(payload, dict):
        _warn("root value is not an object; using metadata-only ranking")
        return {}
    if payload.get("schema_version") != CASE_QUALITY_SCHEMA_VERSION:
        _warn("unsupported schema version; using metadata-only ranking")
        return {}

    raw_cases = payload.get("cases")
    if not isinstance(raw_cases, dict):
        _warn("cases value is not an object; using metadata-only ranking")
        return {}

    cases: dict[str, dict[str, Any]] = {}
    for raw_case_id, record in raw_cases.items():
        case_id = str(raw_case_id or "").strip()
        if case_id and isinstance(record, dict):
            cases[case_id] = record
    return cases


def _record_ct_bytes(record: dict[str, Any]) -> int | None:
    ct = record.get("ct")
    value = ct.get("bytes") if isinstance(ct, dict) else None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _record_thumbnail_status(record: dict[str, Any]) -> str:
    thumbnail = record.get("thumbnail")
    value = thumbnail.get("final_status") if isinstance(thumbnail, dict) else None
    status = str(value or "unknown").strip().lower()
    return status if status in THUMBNAIL_STATUS_RANK else "unknown"


def merge_case_quality(
    df: pd.DataFrame,
    cases: dict[str, dict[str, Any]],
) -> pd.DataFrame:
    """Attach sortable quality columns using normalized canonical case IDs."""
    enriched = df.copy()
    case_values = enriched.get(
        "__case_str",
        pd.Series([""] * len(enriched), index=enriched.index, dtype=object),
    )

    ct_bytes: list[int | None] = []
    statuses: list[str] = []
    for raw_case_id in case_values:
        record = cases.get(str(raw_case_id).strip(), {})
        ct_bytes.append(_record_ct_bytes(record))
        statuses.append(_record_thumbnail_status(record))

    enriched["__ct_bytes"] = pd.to_numeric(
        pd.Series(ct_bytes, index=enriched.index),
        errors="coerce",
    )
    enriched["__thumbnail_status"] = pd.Series(
        statuses,
        index=enriched.index,
        dtype=object,
    )
    enriched["__thumbnail_quality_rank"] = enriched["__thumbnail_status"].map(
        THUMBNAIL_STATUS_RANK
    ).fillna(THUMBNAIL_STATUS_RANK["unknown"])
    return enriched


def inspect_thumbnail(path: str) -> dict[str, Any]:
    """Collect objective image integrity metrics before vision classification."""
    if not os.path.isfile(path):
        return {
            "status": "missing",
            "reasons": ["thumbnail_missing"],
            "metrics": {},
            "sha256": None,
            "bytes": None,
            "width": None,
            "height": None,
            "mode": None,
        }

    try:
        with open(path, "rb") as handle:
            image_bytes = handle.read()
        digest = hashlib.sha256(image_bytes).hexdigest()
        with Image.open(BytesIO(image_bytes)) as source:
            image = ImageOps.exif_transpose(source)
            image.load()
            width, height = image.size
            mode = image.mode
            gray = np.asarray(image.convert("L"), dtype=np.uint8)
    except (OSError, ValueError, Image.DecompressionBombError) as exc:
        return {
            "status": "fail",
            "reasons": ["thumbnail_unreadable"],
            "error": str(exc),
            "metrics": {},
            "sha256": None,
            "bytes": None,
            "width": None,
            "height": None,
            "mode": None,
        }

    reasons: list[str] = []
    if width < 64 or height < 64:
        reasons.append("thumbnail_too_small")

    aspect_ratio = float(width / height) if height else 0.0
    if aspect_ratio < 0.2 or aspect_ratio > 5.0:
        reasons.append("extreme_aspect_ratio")

    if gray.size == 0:
        reasons.append("thumbnail_empty")
        luma_stddev = 0.0
        dynamic_range = 0.0
        dark_fraction = 1.0
        bright_fraction = 0.0
    else:
        luma_stddev = float(np.std(gray))
        low, high = np.percentile(gray, [1, 99])
        dynamic_range = float(high - low)
        dark_fraction = float(np.mean(gray <= 2))
        bright_fraction = float(np.mean(gray >= 253))
        if luma_stddev < 2.0 or dynamic_range < 8.0:
            reasons.append("thumbnail_blank")
        if dark_fraction > 0.995 or bright_fraction > 0.995:
            reasons.append("thumbnail_clipped")

    return {
        "status": "fail" if reasons else "pass",
        "reasons": reasons,
        "metrics": {
            "aspect_ratio": aspect_ratio,
            "luma_stddev": luma_stddev,
            "dynamic_range": dynamic_range,
            "dark_fraction": dark_fraction,
            "bright_fraction": bright_fraction,
        },
        "sha256": digest,
        "bytes": len(image_bytes),
        "width": width,
        "height": height,
        "mode": mode,
    }


def thumbnail_cache_key(thumbnail_sha256: str, model: str) -> str:
    """Fingerprint image content plus detector/model policy."""
    raw = json.dumps(
        {
            "thumbnail_sha256": thumbnail_sha256,
            "detector_version": DETERMINISTIC_DETECTOR_VERSION,
            "vision_prompt_version": VISION_PROMPT_VERSION,
            "vision_model": model,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def normalize_vision_result(result: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalize schema-constrained vision output."""
    if not isinstance(result, dict):
        raise OllamaInvalidResponse("Vision result was not an object.")

    classification = str(result.get("classification") or "").strip().lower()
    if classification not in VISION_CLASSIFICATIONS:
        raise OllamaInvalidResponse("Vision result had an invalid classification.")

    try:
        confidence = float(result.get("confidence"))
    except (TypeError, ValueError) as exc:
        raise OllamaInvalidResponse("Vision result had invalid confidence.") from exc
    if not 0.0 <= confidence <= 1.0:
        raise OllamaInvalidResponse("Vision confidence was outside 0..1.")

    raw_reasons = result.get("reasons")
    if not isinstance(raw_reasons, list):
        raise OllamaInvalidResponse("Vision result reasons were not a list.")
    reasons = [str(reason).strip() for reason in raw_reasons]
    if any(reason not in VISION_REASONS for reason in reasons):
        raise OllamaInvalidResponse("Vision result had an invalid reason.")

    return {
        "classification": classification,
        "confidence": confidence,
        "reasons": reasons,
    }


def classify_thumbnail_with_vision(
    path: str,
    *,
    model: str,
    timeout: float | None = None,
) -> dict[str, Any]:
    """Classify one decodable thumbnail through local Ollama vision."""
    with open(path, "rb") as handle:
        encoded = base64.b64encode(handle.read()).decode("ascii")

    result = chat_structured_json(
        model=model,
        messages=[
            {"role": "system", "content": VISION_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": VISION_USER_PROMPT,
                "images": [encoded],
            },
        ],
        schema=VISION_RESULT_SCHEMA,
        timeout=timeout,
        temperature=0.0,
        seed=42,
    )
    return normalize_vision_result(result)


def resolve_final_thumbnail_status(
    deterministic: dict[str, Any],
    vision: dict[str, Any] | None,
    *,
    confidence_threshold: float = VISION_CONFIDENCE_THRESHOLD,
) -> str:
    """Resolve conservative runtime status from objective and vision checks."""
    deterministic_status = str(deterministic.get("status") or "").lower()
    reasons = set(deterministic.get("reasons") or [])
    if deterministic_status == "missing" or "thumbnail_missing" in reasons:
        return "unknown"
    if deterministic_status == "fail":
        return "distorted"
    if not vision:
        return "unknown"

    normalized = normalize_vision_result(vision)
    if normalized["confidence"] < confidence_threshold:
        return "unknown"
    if normalized["classification"] in {"undistorted", "distorted"}:
        return normalized["classification"]
    return "unknown"
