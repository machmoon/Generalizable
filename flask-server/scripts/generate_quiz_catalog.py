#!/usr/bin/env python3
"""Generate and gate a deterministic BodyMaps VQA catalog on a dataset host."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.quiz_generation import (  # noqa: E402
    DEFAULT_LEDGER_PATH,
    DEFAULT_PROFILE_PATH,
    QuizGenerationError,
    generate_release,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset-root", required=True, type=Path)
    parser.add_argument(
        "--metadata",
        type=Path,
        help="Optional metadata.xlsx. Omit for public PanTS mirrors; positivity is read from combined labels.",
    )
    parser.add_argument("--target", required=True, type=int, choices=(50, 100, 500))
    parser.add_argument("--output-catalog", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--qa-dir", required=True, type=Path)
    parser.add_argument("--draft-catalog", type=Path)
    parser.add_argument("--profiles", type=Path, default=DEFAULT_PROFILE_PATH)
    parser.add_argument("--approval-ledger", type=Path, default=DEFAULT_LEDGER_PATH)
    parser.add_argument("--seed", default="bodymaps-vqa-v2")
    parser.add_argument(
        "--allow-unreviewed",
        action="store_true",
        help="Write structurally valid pending packs to a development catalog for implementation testing.",
    )
    parser.add_argument(
        "--local-artifacts-only",
        action="store_true",
        help="With --metadata, consider only candidates whose CT and mask are staged locally.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.local_artifacts_only and args.metadata is None:
        print(json.dumps({"passed": False, "code": "metadata_required", "error": "--local-artifacts-only requires --metadata"}, sort_keys=True))
        return 2
    try:
        report = generate_release(
            dataset_root=args.dataset_root,
            metadata_path=args.metadata,
            target=args.target,
            output_catalog=args.output_catalog,
            report_path=args.report,
            qa_dir=args.qa_dir,
            draft_catalog_path=args.draft_catalog,
            profile_path=args.profiles,
            ledger_path=args.approval_ledger,
            seed=args.seed,
            allow_unreviewed=args.allow_unreviewed,
            local_artifacts_only=args.local_artifacts_only,
        )
    except QuizGenerationError as exc:
        print(json.dumps({"passed": False, "code": exc.code, "error": str(exc)}, sort_keys=True))
        return 2
    acceptance = report["acceptance"]
    print(json.dumps({
        "passed": acceptance["passed"],
        "target": args.target,
        "attempted_candidates": report["run"]["attempted_candidates"],
        "generated_pack_count": acceptance["generated_pack_count"],
        "published_pack_count": acceptance["published_pack_count"],
        "approved_pack_count": acceptance["approved_pack_count"],
        "composition": acceptance["composition"],
        "report_question_count": acceptance["report_question_count"],
        "missing_report_pack_count": acceptance["missing_report_pack_count"],
        "failure_count": len(report["failures"]),
        "warning_count": len(report["warnings"]),
        "report": str(args.report.resolve()),
    }, sort_keys=True))
    return 0 if acceptance["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
