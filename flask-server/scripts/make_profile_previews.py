#!/usr/bin/env python3
"""
Offline batch job: generate profile-card thumbnails for CancerVerse cases, matching
PanTS's existing <PANTS_PATH>/profile_only/<case>/profile.jpg convention (a bone-window
coronal MIP, 512x512 RGB JPEG — see api/api_blueprint.py:get_image_preview).

Output mirrors the PanTS layout exactly, written under CANCERVERSE_PATH itself:
    <CANCERVERSE_PATH>/profile_only/<CV id>/profile.jpg
Override the destination with --out-root if your CANCERVERSE_PATH mount is read-only.

Usage (on the server — use the conda python that runs the backend):
    PYBIN=/home/visitor/.conda/envs/PanTS_backend/bin/python3.11
    cd flask-server
    # quick trial run first:
    $PYBIN scripts/make_profile_previews.py --limit 5
    # then the full batch (long-running — run under nohup/tmux):
    nohup $PYBIN scripts/make_profile_previews.py > /tmp/make_profile_previews.log 2>&1 &
"""
import argparse
import glob
import os
import sys
import time

import nibabel as nib
import nibabel.orientations as nio
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from constants import Constants  # noqa: E402

CT_NAME = "ct.nii.gz"
PROFILE_NAME = "profile.jpg"
THUMB_SIZE = (512, 512)
# Bone window (HU): calibrated against PanTS's existing profile.jpg output so both
# datasets' cards look like the same product, not two different pipelines.
WINDOW_LO = 375
WINDOW_HI = 1300
_LPS = nio.axcodes2ornt(("L", "P", "S"))


def _coronal_mip_lps(ct_path: str) -> np.ndarray:
    """Bone-window coronal MIP, oriented head-up/patient-left-on-image-right (LPS)."""
    img = nib.load(ct_path)
    xfm = nio.ornt_transform(nio.io_orientation(img.affine), _LPS)
    data = nio.apply_orientation(np.asanyarray(img.dataobj), xfm).astype(np.float32)

    mip = np.clip(data, WINDOW_LO, WINDOW_HI).max(axis=1)  # project A->P, keep (L, S)
    frame = np.flipud(mip.T)  # rows=S (superior at top), cols=L
    norm = (frame - WINDOW_LO) / (WINDOW_HI - WINDOW_LO)
    return (norm * 255).astype(np.uint8)


def _process_case(ct_path: str, out_root: str, overwrite: bool) -> str:
    case_id = os.path.basename(os.path.dirname(ct_path))
    out_path = os.path.join(out_root, "profile_only", case_id, PROFILE_NAME)
    if os.path.exists(out_path) and not overwrite:
        return "skip"
    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    arr8 = _coronal_mip_lps(ct_path)
    im = Image.fromarray(arr8).resize(THUMB_SIZE, resample=Image.BICUBIC).convert("RGB")
    im.save(out_path, format="JPEG", quality=90)
    return "ok"


def main():
    default_out = os.environ.get("CANCERVERSE_PATH", Constants.CANCERVERSE_PATH)
    ap = argparse.ArgumentParser(description="Generate CancerVerse profile-card thumbnails.")
    ap.add_argument("--out-root", default=default_out,
                     help=f"writable dir for profile_only/ output (default: {default_out})")
    ap.add_argument("--overwrite", action="store_true", help="regenerate even if profile.jpg exists")
    ap.add_argument("--limit", type=int, default=0, help="process at most N cases (0 = all)")
    args = ap.parse_args()

    if not Constants.CANCERVERSE_PATH:
        sys.exit("CANCERVERSE_PATH not set — check flask-server/.env")
    if not args.out_root:
        sys.exit("--out-root not set and CANCERVERSE_PATH is empty")

    # CT volumes live at <CANCERVERSE_PATH>/image_only/<case>/ct.nii.gz, mirroring the
    # PanTS layout (see constants.py).
    root = Constants.CANCERVERSE_PATH
    ct_paths = sorted(glob.glob(os.path.join(root, "image_only", "*", CT_NAME)))
    if args.limit:
        ct_paths = ct_paths[: args.limit]

    print(f"Found {len(ct_paths)} CT volumes under {root}")
    print(f"Writing profile thumbnails under {args.out_root}/profile_only/")
    counts = {"ok": 0, "skip": 0, "err": 0}
    t0 = time.time()
    for i, ct in enumerate(ct_paths, 1):
        try:
            result = _process_case(ct, args.out_root, args.overwrite)
        except Exception as e:  # never let one bad file abort the batch
            result = "err"
            print(f"  [err] {ct}: {e}")
        counts[result] += 1
        if i % 25 == 0 or i == len(ct_paths):
            print(f"  {i}/{len(ct_paths)}  ok={counts['ok']} skip={counts['skip']} "
                  f"err={counts['err']}  ({time.time()-t0:.0f}s)")

    print(f"Done: {counts}")


if __name__ == "__main__":
    main()
