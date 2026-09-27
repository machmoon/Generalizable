#!/usr/bin/env python3
"""Build offline CT-size and thumbnail-vision metadata for search ranking."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api.utils import DF, DF_CV, get_case_nifti_paths  # noqa: E402
from constants import Constants  # noqa: E402
from services.case_quality import (  # noqa: E402
    CASE_QUALITY_SCHEMA_VERSION,
    DETERMINISTIC_DETECTOR_VERSION,
    VISION_PROMPT_VERSION,
    classify_thumbnail_with_vision,
    inspect_thumbnail,
    resolve_final_thumbnail_status,
    thumbnail_cache_key,
)
from services.ollama_client import (  # noqa: E402
    OllamaInvalidResponse,
    OllamaUnavailable,
    list_ollama_models,
)


def _load_existing(path: str) -> dict[str, Any]:
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
        return {}
    if (
        not isinstance(payload, dict)
        or payload.get("schema_version") != CASE_QUALITY_SCHEMA_VERSION
        or not isinstance(payload.get("cases"), dict)
    ):
        return {}
    return payload


def _case_ids(dataset: str) -> list[str]:
    values: list[str] = []
    if dataset in {"pants", "all"}:
        values.extend(DF["__case_str"].dropna().astype(str).tolist())
    if dataset in {"cancerverse", "all"} and DF_CV is not None:
        values.extend(DF_CV["__case_str"].dropna().astype(str).tolist())
    return sorted({value.strip() for value in values if value.strip()})


def _thumbnail_path(case_id: str) -> str | None:
    paths = get_case_nifti_paths(case_id)
    if paths["dataset"] != "PanTS" or not Constants.PANTS_PATH:
        return None
    return os.path.join(
        Constants.PANTS_PATH,
        "profile_only",
        paths["folder_id"],
        "profile.jpg",
    )


def _ct_record(case_id: str) -> dict[str, Any]:
    ct_path = get_case_nifti_paths(case_id)["image"]
    try:
        stat = os.stat(ct_path)
    except OSError:
        return {"exists": False, "bytes": None, "mtime_ns": None}
    return {
        "exists": True,
        "bytes": int(stat.st_size),
        "mtime_ns": int(stat.st_mtime_ns),
    }


def _vision_available(model: str) -> bool:
    installed = {item["name"] for item in list_ollama_models()}
    return model in installed


def _cached_record_matches(
    record: dict[str, Any],
    *,
    ct: dict[str, Any],
    deterministic: dict[str, Any],
    cache_key: str | None,
) -> bool:
    old_ct = record.get("ct")
    old_thumbnail = record.get("thumbnail")
    if not isinstance(old_ct, dict) or not isinstance(old_thumbnail, dict):
        return False
    if old_ct.get("bytes") != ct.get("bytes") or old_ct.get("mtime_ns") != ct.get("mtime_ns"):
        return False
    if deterministic.get("status") == "missing":
        return old_thumbnail.get("exists") is False
    return bool(cache_key and old_thumbnail.get("cache_key") == cache_key)


def _process_case(
    case_id: str,
    *,
    model: str,
    vision_mode: str,
    vision_timeout: float,
) -> dict[str, Any]:
    paths = get_case_nifti_paths(case_id)
    ct = _ct_record(case_id)
    thumbnail_path = _thumbnail_path(case_id)
    deterministic = inspect_thumbnail(thumbnail_path or "")
    digest = deterministic.get("sha256")
    cache_model = model if vision_mode != "off" else "vision-off"
    cache_key = thumbnail_cache_key(digest, cache_model) if digest else None

    vision: dict[str, Any] = {
        "status": "not_run",
        "classification": None,
        "confidence": None,
        "reasons": [],
        "model": None,
        "prompt_version": VISION_PROMPT_VERSION,
    }
    if deterministic.get("status") == "pass" and vision_mode != "off":
        try:
            result = classify_thumbnail_with_vision(
                thumbnail_path or "",
                model=model,
                timeout=vision_timeout,
            )
            vision = {
                "status": "complete",
                **result,
                "model": model,
                "prompt_version": VISION_PROMPT_VERSION,
            }
        except (OSError, OllamaUnavailable, OllamaInvalidResponse, ValueError) as exc:
            if vision_mode == "required":
                raise
            vision = {
                "status": "error",
                "classification": None,
                "confidence": None,
                "reasons": ["vision_unavailable"],
                "error": str(exc),
                "model": model,
                "prompt_version": VISION_PROMPT_VERSION,
            }

    final_status = resolve_final_thumbnail_status(deterministic, vision)
    return {
        "dataset": paths["dataset"],
        "ct": ct,
        "thumbnail": {
            "exists": deterministic.get("status") != "missing",
            "bytes": deterministic.get("bytes"),
            "width": deterministic.get("width"),
            "height": deterministic.get("height"),
            "mode": deterministic.get("mode"),
            "sha256": digest,
            "cache_key": cache_key,
            "deterministic": {
                "status": deterministic.get("status"),
                "reasons": deterministic.get("reasons") or [],
                "metrics": deterministic.get("metrics") or {},
                "version": DETERMINISTIC_DETECTOR_VERSION,
            },
            "vision": vision,
            "final_status": final_status,
        },
    }


def _write_atomic(path: str, payload: dict[str, Any]) -> None:
    directory = os.path.dirname(os.path.abspath(path))
    os.makedirs(directory, exist_ok=True)
    temporary = f"{path}.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temporary, path)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate offline case quality metadata for search and shuffle.",
    )
    parser.add_argument(
        "--out",
        default=(
            Constants.CASE_QUALITY_MANIFEST
            or os.path.join(Constants.PERMISSIONS_DIR, "bodymaps_case_quality.v1.json")
        ),
        help="output manifest path",
    )
    parser.add_argument(
        "--datasets",
        choices=("pants", "cancerverse", "all"),
        default="all",
    )
    parser.add_argument(
        "--vision",
        choices=("off", "auto", "required"),
        default="auto",
    )
    parser.add_argument(
        "--vision-model",
        default=Constants.THUMBNAIL_VISION_MODEL,
    )
    parser.add_argument(
        "--vision-timeout",
        type=float,
        default=Constants.THUMBNAIL_VISION_TIMEOUT_SECONDS,
    )
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--overwrite", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--case-id")
    args = parser.parse_args()

    if not args.out:
        sys.exit("BODYMAPS_CASE_QUALITY_MANIFEST or --out is required")
    if os.path.exists(args.out) and not (args.resume or args.overwrite):
        sys.exit("Output exists; pass --resume or --overwrite")

    if args.vision in {"auto", "required"}:
        try:
            available = _vision_available(args.vision_model)
        except OllamaUnavailable as exc:
            if args.vision == "required":
                sys.exit(f"Ollama unavailable: {exc}")
            available = False
        if not available:
            if args.vision == "required":
                sys.exit(f"Vision model not installed: {args.vision_model}")
            print(f"[WARN] Vision model unavailable; recording unknown: {args.vision_model}")
            args.vision = "off"

    existing = _load_existing(args.out) if args.resume else {}
    cases: dict[str, Any] = dict(existing.get("cases") or {})
    selected = _case_ids(args.datasets)
    if args.case_id:
        selected = [case_id for case_id in selected if case_id == args.case_id]
    if args.limit > 0:
        selected = selected[: args.limit]
    if not selected:
        sys.exit("No matching cases found")

    counts = {
        "processed": 0,
        "cached": 0,
        "undistorted": 0,
        "distorted": 0,
        "unknown": 0,
        "missing_ct": 0,
        "missing_thumbnail": 0,
        "vision_errors": 0,
    }

    for index, case_id in enumerate(selected, start=1):
        ct = _ct_record(case_id)
        thumbnail_path = _thumbnail_path(case_id)
        deterministic = inspect_thumbnail(thumbnail_path or "")
        digest = deterministic.get("sha256")
        cache_model = args.vision_model if args.vision != "off" else "vision-off"
        cache_key = thumbnail_cache_key(digest, cache_model) if digest else None
        old_record = cases.get(case_id)
        if (
            not args.overwrite
            and isinstance(old_record, dict)
            and _cached_record_matches(
                old_record,
                ct=ct,
                deterministic=deterministic,
                cache_key=cache_key,
            )
        ):
            record = old_record
            counts["cached"] += 1
        else:
            record = _process_case(
                case_id,
                model=args.vision_model,
                vision_mode=args.vision,
                vision_timeout=args.vision_timeout,
            )
            cases[case_id] = record
            counts["processed"] += 1

        status = ((record.get("thumbnail") or {}).get("final_status") or "unknown")
        counts[status if status in {"undistorted", "distorted"} else "unknown"] += 1
        if not (record.get("ct") or {}).get("exists"):
            counts["missing_ct"] += 1
        thumbnail = record.get("thumbnail") or {}
        if not thumbnail.get("exists"):
            counts["missing_thumbnail"] += 1
        if (thumbnail.get("vision") or {}).get("status") == "error":
            counts["vision_errors"] += 1

        if index % 100 == 0 or index == len(selected):
            print(f"{index}/{len(selected)} cases processed")

    payload = {
        "schema_version": CASE_QUALITY_SCHEMA_VERSION,
        "manifest_version": "bodymaps-case-quality-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "generator": {
            "deterministic_detector_version": DETERMINISTIC_DETECTOR_VERSION,
            "vision_prompt_version": VISION_PROMPT_VERSION,
            "vision_model": args.vision_model,
            "vision_mode": args.vision,
        },
        "cases": dict(sorted(cases.items())),
    }
    _write_atomic(args.out, payload)
    print(json.dumps(counts, sort_keys=True))
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
