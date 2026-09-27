#!/usr/bin/env python3
"""Stage a deterministic, mask-validated PanTS cohort for quiz generation."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import ssl
import sys
import tarfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

import nibabel as nib
import numpy as np
import certifi

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.quiz_generation import (  # noqa: E402
    DEFAULT_PROFILE_PATH,
    TARGETS,
    Candidate,
    LabelProfileRegistry,
    QuizGenerationError,
    _atomic_json,
    _candidate_order,
    _mask_for_labels,
    load_candidates,
)


DEFAULT_REPO_ID = "BodyMaps/iPanTSMini"
DEFAULT_SEED = "bodymaps-vqa-v1"
OFFICIAL_MASK_ARCHIVE_URL = "https://www.cs.jhu.edu/~zongwei/dataset/PanTSMini_Label.tar.gz"
REQUIRED_CASE_IDS = {"35"}
CHUNK_SIZE = 1024 * 1024
TLS_CONTEXT = ssl.create_default_context(cafile=certifi.where())
CASE_DIRECTORY_PATTERN = re.compile(r"PanTS_\d{8}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-root", required=True, type=Path)
    parser.add_argument("--target", type=int, choices=(50, 100, 500), default=500)
    parser.add_argument("--repo-id", default=DEFAULT_REPO_ID)
    parser.add_argument("--revision", default="main")
    parser.add_argument("--profiles", type=Path, default=DEFAULT_PROFILE_PATH)
    parser.add_argument("--seed", default=DEFAULT_SEED)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument(
        "--metadata",
        type=Path,
        help="Optional official metadata.xlsx used to preselect candidates before mask validation.",
    )
    mask_source = parser.add_mutually_exclusive_group()
    mask_source.add_argument(
        "--mask-archive",
        type=Path,
        help="Existing official PanTSMini_Label.tar.gz to stage before remote mirror masks.",
    )
    mask_source.add_argument(
        "--download-official-masks",
        action="store_true",
        help="Resume-download and stage the official PanTSMini label archive from JHU.",
    )
    parser.add_argument("--masks-only", action="store_true")
    return parser.parse_args()


def _request_json(url: str) -> dict[str, Any]:
    request = Request(url, headers={"User-Agent": "BodyMaps-quiz-stager/1.0"})
    try:
        with urlopen(request, timeout=120, context=TLS_CONTEXT) as response:
            value = json.load(response)
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise QuizGenerationError("remote_inventory_failed", f"Could not load {url}") from exc
    if not isinstance(value, dict):
        raise QuizGenerationError("remote_inventory_failed", "Remote inventory response is invalid")
    return value


def remote_inventory(repo_id: str) -> set[str]:
    encoded_repo = quote(repo_id, safe="/")
    payload = _request_json(f"https://huggingface.co/api/datasets/{encoded_repo}")
    siblings = payload.get("siblings")
    if not isinstance(siblings, list):
        raise QuizGenerationError("remote_inventory_failed", "Remote inventory has no siblings list")
    return {
        str(item["rfilename"])
        for item in siblings
        if isinstance(item, dict) and isinstance(item.get("rfilename"), str)
    }


def _remote_url(repo_id: str, revision: str, relative_path: str) -> str:
    return (
        f"https://huggingface.co/datasets/{quote(repo_id, safe='/')}/resolve/"
        f"{quote(revision, safe='')}/{quote(relative_path, safe='/')}?download=true"
    )


def download_file(url: str, destination: Path) -> str:
    if destination.is_file() and destination.stat().st_size > 0:
        return "existing"
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(f".{destination.name}.part")
    offset = partial.stat().st_size if partial.is_file() else 0
    headers = {"User-Agent": "BodyMaps-quiz-stager/1.0"}
    if offset:
        headers["Range"] = f"bytes={offset}-"
    request = Request(url, headers=headers)
    try:
        with urlopen(request, timeout=300, context=TLS_CONTEXT) as response:
            append = offset > 0 and getattr(response, "status", None) == 206
            with partial.open("ab" if append else "wb") as stream:
                while chunk := response.read(CHUNK_SIZE):
                    stream.write(chunk)
                stream.flush()
                os.fsync(stream.fileno())
        os.replace(partial, destination)
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        raise QuizGenerationError("download_failed", f"Could not download {url}") from exc
    return "downloaded"


def extract_combined_labels(archive_path: Path, dataset_root: Path) -> dict[str, int]:
    """Stream only combined-label files from the official archive into mask_only/."""
    counts = {"extracted": 0, "existing": 0}
    try:
        with tarfile.open(archive_path, mode="r|gz") as archive:
            for member in archive:
                parts = Path(member.name).parts
                if (
                    not member.isfile()
                    or len(parts) != 2
                    or not CASE_DIRECTORY_PATTERN.fullmatch(parts[0])
                    or parts[1] != "combined_labels.nii.gz"
                ):
                    continue
                destination = dataset_root / "mask_only" / parts[0] / parts[1]
                if destination.is_file() and destination.stat().st_size > 0:
                    counts["existing"] += 1
                    continue
                source = archive.extractfile(member)
                if source is None:
                    raise QuizGenerationError(
                        "mask_archive_invalid",
                        f"Could not read {member.name} from {archive_path}",
                    )
                destination.parent.mkdir(parents=True, exist_ok=True)
                partial = destination.with_name(f".{destination.name}.part")
                with source, partial.open("wb") as stream:
                    shutil.copyfileobj(source, stream, length=CHUNK_SIZE)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(partial, destination)
                counts["extracted"] += 1
    except (OSError, tarfile.TarError) as exc:
        raise QuizGenerationError(
            "mask_archive_invalid",
            f"Could not extract official combined labels from {archive_path}",
        ) from exc
    return counts


def download_many(
    repo_id: str,
    revision: str,
    dataset_root: Path,
    paths: list[str],
    workers: int,
) -> dict[str, int]:
    counts = {"downloaded": 0, "existing": 0}
    lock = threading.Lock()
    completed = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as executor:
        futures = {
            executor.submit(
                download_file,
                _remote_url(repo_id, revision, relative_path),
                dataset_root / relative_path,
            ): relative_path
            for relative_path in paths
        }
        for future in as_completed(futures):
            status = future.result()
            with lock:
                counts[status] += 1
                completed += 1
                if completed == len(paths) or completed % 25 == 0:
                    print(
                        json.dumps({
                            "phase": "download",
                            "completed": completed,
                            "total": len(paths),
                            **counts,
                        }, sort_keys=True),
                        flush=True,
                    )
    return counts


def inspect_staged_masks(
    dataset_root: Path,
    profiles: LabelProfileRegistry,
) -> tuple[list[Candidate], list[dict[str, str]]]:
    candidates: list[Candidate] = []
    failures: list[dict[str, str]] = []
    paths = sorted((dataset_root / "mask_only").glob("PanTS_*/combined_labels.nii.gz"))
    for index, mask_path in enumerate(paths, start=1):
        dataset_id = mask_path.parent.name
        suffix = dataset_id.removeprefix("PanTS_")
        if not suffix.isdigit():
            continue
        case_id = str(int(suffix))
        try:
            profile = profiles.resolve(case_id)
            image = nib.load(str(mask_path))
            data = np.asanyarray(image.dataobj)
            pancreas = _mask_for_labels(data, profile["labels"]["pancreas"])
            if not np.any(pancreas):
                raise QuizGenerationError("empty_pancreas", f"Pancreas mask is empty for {dataset_id}")
            lesion = _mask_for_labels(data, profile["labels"]["lesion"])
            spacing = tuple(float(value) for value in image.header.get_zooms()[:3])
            candidates.append(Candidate(
                case_id=case_id,
                dataset_id=dataset_id,
                tumor_positive=bool(np.any(lesion)),
                spacing=spacing,
                metadata={"candidate_source": "combined_labels"},
            ))
        except (QuizGenerationError, OSError, ValueError) as exc:
            failures.append({
                "dataset_id": dataset_id,
                "code": getattr(exc, "code", "unreadable_artifact"),
                "message": str(exc),
            })
        if index == len(paths) or index % 100 == 0:
            print(json.dumps({
                "phase": "inspect_masks",
                "completed": index,
                "total": len(paths),
                "valid": len(candidates),
                "failures": len(failures),
            }, sort_keys=True), flush=True)
    return candidates, failures


def validate_mask_cohort(
    dataset_root: Path,
    candidates: list[Candidate],
    profiles: LabelProfileRegistry,
    target: int,
    seed: str,
    reserve_per_class: int,
) -> tuple[list[Candidate], list[dict[str, str]]]:
    """Validate only deterministic quota candidates plus fallback reserves."""
    target_positive, target_normal = TARGETS[target]
    valid: list[Candidate] = []
    failures: list[dict[str, str]] = []
    inspected = 0
    for positive, quota in ((True, target_positive), (False, target_normal)):
        ordered = _candidate_order(candidates, seed, positive)
        ordered.sort(key=lambda item: item.case_id not in REQUIRED_CASE_IDS)
        needed = quota + max(1, reserve_per_class)
        accepted: list[Candidate] = []
        for candidate in ordered:
            mask_path = dataset_root / "mask_only" / candidate.dataset_id / "combined_labels.nii.gz"
            try:
                if not mask_path.is_file():
                    raise QuizGenerationError("missing_mask", f"Missing segmentation for {candidate.dataset_id}")
                profile = profiles.resolve(candidate.case_id)
                image = nib.load(str(mask_path))
                data = np.asanyarray(image.dataobj)
                if not np.any(_mask_for_labels(data, profile["labels"]["pancreas"])):
                    raise QuizGenerationError("empty_pancreas", f"Pancreas mask is empty for {candidate.dataset_id}")
                lesion_present = bool(np.any(_mask_for_labels(data, profile["labels"]["lesion"])))
                if lesion_present != candidate.tumor_positive:
                    code = "empty_lesion" if candidate.tumor_positive else "unexpected_lesion"
                    raise QuizGenerationError(code, f"Metadata and lesion mask disagree for {candidate.dataset_id}")
                accepted.append(candidate)
            except (QuizGenerationError, OSError, ValueError) as exc:
                failures.append({
                    "dataset_id": candidate.dataset_id,
                    "code": getattr(exc, "code", "unreadable_artifact"),
                    "message": str(exc),
                })
            inspected += 1
            if inspected % 100 == 0:
                print(json.dumps({
                    "phase": "validate_mask_cohort",
                    "inspected": inspected,
                    "valid": len(valid) + len(accepted),
                    "failures": len(failures),
                }, sort_keys=True), flush=True)
            if len(accepted) >= needed:
                break
        if len(accepted) < quota:
            label = "positive" if positive else "normal"
            raise QuizGenerationError("insufficient_candidates", f"Need {quota} valid {label} masks, found {len(accepted)}")
        valid.extend(accepted)
    return valid, failures


def _pair_is_valid(dataset_root: Path, candidate: Candidate) -> tuple[bool, str | None]:
    ct_path = dataset_root / "image_only" / candidate.dataset_id / "ct.nii.gz"
    mask_path = dataset_root / "mask_only" / candidate.dataset_id / "combined_labels.nii.gz"
    try:
        ct = nib.load(str(ct_path))
        mask = nib.load(str(mask_path))
        ct_affine = np.asarray(ct.affine, dtype=float)
        mask_affine = np.asarray(mask.affine, dtype=float)
        if tuple(ct.shape[:3]) != tuple(mask.shape[:3]):
            return False, "mismatched_shape"
        if not np.all(np.isfinite(ct_affine)) or not np.all(np.isfinite(mask_affine)):
            return False, "non_finite_affine"
        if abs(float(np.linalg.det(ct_affine[:3, :3]))) < 1e-8 or abs(float(np.linalg.det(mask_affine[:3, :3]))) < 1e-8:
            return False, "singular_affine"
        if not np.allclose(ct_affine, mask_affine, atol=1e-4):
            return False, "mismatched_affine"
    except (OSError, ValueError) as exc:
        return False, f"unreadable_artifact:{exc}"
    return True, None


def stage_ct_cohort(
    *,
    repo_id: str,
    revision: str,
    dataset_root: Path,
    candidates: list[Candidate],
    target: int,
    seed: str,
    workers: int,
) -> tuple[list[Candidate], list[dict[str, str]], dict[str, int]]:
    target_positive, target_normal = TARGETS[target]
    selected: list[Candidate] = []
    failures: list[dict[str, str]] = []
    totals = {"downloaded": 0, "existing": 0}
    for positive, quota in ((True, target_positive), (False, target_normal)):
        ordered = _candidate_order(candidates, seed, positive)
        ordered.sort(key=lambda item: item.case_id not in REQUIRED_CASE_IDS)
        if len(ordered) < quota:
            label = "positive" if positive else "normal"
            raise QuizGenerationError("insufficient_candidates", f"Need {quota} {label} cases, found {len(ordered)}")
        valid: list[Candidate] = []
        cursor = 0
        while len(valid) < quota:
            needed = quota - len(valid)
            batch = ordered[cursor:cursor + max(needed, workers)]
            if not batch:
                label = "positive" if positive else "normal"
                raise QuizGenerationError("insufficient_valid_pairs", f"Could not stage {quota} valid {label} CT/mask pairs")
            paths = [f"image_only/{item.dataset_id}/ct.nii.gz" for item in batch]
            counts = download_many(repo_id, revision, dataset_root, paths, workers)
            for key in totals:
                totals[key] += counts[key]
            for candidate in batch:
                valid_pair, reason = _pair_is_valid(dataset_root, candidate)
                if valid_pair:
                    valid.append(candidate)
                else:
                    failures.append({
                        "dataset_id": candidate.dataset_id,
                        "code": str(reason),
                        "message": "CT and combined-label geometry failed staging validation",
                    })
            cursor += len(batch)
        selected.extend(valid[:quota])
    return selected, failures, totals


def main() -> int:
    args = parse_args()
    dataset_root = args.dataset_root.resolve()
    manifest_path = (args.manifest or dataset_root / "quiz" / "staging_manifest.v1.json").resolve()
    try:
        archive_path: Path | None = args.mask_archive.resolve() if args.mask_archive else None
        archive_download = None
        if args.download_official_masks:
            archive_path = dataset_root / "quiz" / "source" / "PanTSMini_Label.tar.gz"
            archive_download = download_file(OFFICIAL_MASK_ARCHIVE_URL, archive_path)
        archive_staging = None
        if archive_path is not None:
            if not archive_path.is_file():
                raise QuizGenerationError("mask_archive_missing", f"Mask archive not found: {archive_path}")
            print(json.dumps({"phase": "official_masks", "archive": str(archive_path)}, sort_keys=True), flush=True)
            archive_staging = extract_combined_labels(archive_path, dataset_root)
        inventory = remote_inventory(args.repo_id)
        mask_paths = sorted(
            path for path in inventory
            if path.startswith("mask_only/PanTS_") and path.endswith("/combined_labels.nii.gz")
        )
        ct_paths = {
            path for path in inventory
            if path.startswith("image_only/PanTS_") and path.endswith("/ct.nii.gz")
        }
        mask_paths = [
            path for path in mask_paths
            if path.replace("mask_only/", "image_only/").replace("combined_labels.nii.gz", "ct.nii.gz") in ct_paths
        ]
        if not mask_paths:
            raise QuizGenerationError("remote_inventory_failed", "Remote inventory has no CT/mask pairs")
        print(json.dumps({"phase": "inventory", "paired_cases": len(mask_paths)}, sort_keys=True), flush=True)
        mask_downloads = download_many(
            args.repo_id,
            args.revision,
            dataset_root,
            mask_paths,
            args.workers,
        )
        profiles = LabelProfileRegistry.from_path(args.profiles)
        if args.metadata is not None:
            metadata_candidates = load_candidates(args.metadata)
            candidates, mask_failures = validate_mask_cohort(
                dataset_root,
                metadata_candidates,
                profiles,
                args.target,
                args.seed,
                args.workers,
            )
        else:
            candidates, mask_failures = inspect_staged_masks(dataset_root, profiles)
        counts = {
            "positive": sum(item.tumor_positive for item in candidates),
            "normal": sum(not item.tumor_positive for item in candidates),
        }
        selected: list[Candidate] = []
        pair_failures: list[dict[str, str]] = []
        ct_downloads = {"downloaded": 0, "existing": 0}
        if not args.masks_only:
            selected, pair_failures, ct_downloads = stage_ct_cohort(
                repo_id=args.repo_id,
                revision=args.revision,
                dataset_root=dataset_root,
                candidates=candidates,
                target=args.target,
                seed=args.seed,
                workers=args.workers,
            )
        manifest = {
            "manifest_version": 1,
            "repo_id": args.repo_id,
            "revision": args.revision,
            "target": args.target,
            "seed": args.seed,
            "remote_pair_count": len(mask_paths),
            "valid_mask_candidate_count": len(candidates),
            "candidate_composition": counts,
            "selected_composition": {
                "positive": sum(item.tumor_positive for item in selected),
                "normal": sum(not item.tumor_positive for item in selected),
            },
            "selected_dataset_ids": [item.dataset_id for item in selected],
            "mask_downloads": mask_downloads,
            "official_mask_archive": (
                {
                    "path": str(archive_path),
                    "download": archive_download,
                    "staging": archive_staging,
                }
                if archive_path is not None
                else None
            ),
            "ct_downloads": ct_downloads,
            "mask_failures": mask_failures,
            "pair_failures": pair_failures,
        }
        _atomic_json(manifest_path, manifest)
        print(json.dumps({
            "passed": bool(args.masks_only or len(selected) == args.target),
            "manifest": str(manifest_path),
            "candidate_composition": counts,
            "selected_composition": manifest["selected_composition"],
            "mask_failure_count": len(mask_failures),
            "pair_failure_count": len(pair_failures),
        }, sort_keys=True), flush=True)
        return 0
    except QuizGenerationError as exc:
        print(json.dumps({"passed": False, "code": exc.code, "error": str(exc)}, sort_keys=True), flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
