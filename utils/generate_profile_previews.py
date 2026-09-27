#!/usr/bin/env python3
"""
Offline batch job: generate profile-card thumbnails (bone-window coronal MIP, 512x512 RGB
JPEG) from an arbitrary directory tree of CT volumes (e.g. PanTS/CancerVerse-style datasets,
or any mixed corpus of NIfTI CTs). Input and output roots are plain CLI args, for running
over a large mixed corpus (e.g. 400k CTs spanning multiple datasets) in one pass.

Orientation: every volume is reoriented to a canonical LPS frame from ITS OWN affine before
the MIP is taken (not assumed from the dataset it came from), so the output is upright/
head-up the same way regardless of how the source scan was stored. That's what makes it
safe to point this at a mixed corpus without per-dataset branching — a CancerVerse scan
with a different native orientation than PanTS still comes out looking the same.

Input discovery: recursively finds files under --root matching --pattern (default
"ct.nii.gz", i.e. the PanTS/CancerVerse convention of one CT per case directory). Case ids
are derived so the common layouts collapse to the same convention:
  - Fixed filename pattern (e.g. the default "ct.nii.gz"): the case id is the volume's
    PARENT directory name, e.g. <root>/.../<case_id>/ct.nii.gz
      -> <root>/image_only/<case_id>/ct.nii.gz   (PanTS-style, nested)a#!/usr/bin/env python3
"""
Offline batch job: generate profile-card thumbnails (bone-window coronal MIP, 512x512 RGB
JPEG) from an arbitrary directory tree of CT volumes (e.g. PanTS/CancerVerse-style datasets,
or any mixed corpus of NIfTI CTs). Input and output roots are plain CLI args, for running
over a large mixed corpus (e.g. 400k CTs spanning multiple datasets) in one pass.

Orientation: every volume is reoriented to a canonical LPS frame from ITS OWN affine before
the MIP is taken (not assumed from the dataset it came from), so the output is upright/
head-up the same way regardless of how the source scan was stored. That's what makes it
safe to point this at a mixed corpus without per-dataset branching — a CancerVerse scan
with a different native orientation than PanTS still comes out looking the same.

Input discovery: recursively finds files under --root matching --pattern (default
"ct.nii.gz", i.e. the PanTS/CancerVerse convention of one CT per case directory). Case ids
are derived so the common layouts collapse to the same convention:
  - Fixed filename pattern (e.g. the default "ct.nii.gz"): the case id is the volume's
    PARENT directory name, e.g. <root>/.../<case_id>/ct.nii.gz
      -> <root>/image_only/<case_id>/ct.nii.gz   (PanTS-style, nested)
      -> <root>/<case_id>/ct.nii.gz               (CancerVerse-style, flat)
    both resolve to the same <case_id>.
  - Wildcard pattern (e.g. --pattern '*.nii.gz'): the case id is the filename itself
    (without .nii/.nii.gz), since there's no per-case directory to read an id from.
Output always lands at:
    <out_root>/profile_only/<case_id>/profile.jpg

Usage (requires: nibabel, numpy, Pillow, tqdm):
    # quick trial run first:
    python3 generate_profile_previews.py /path/to/ct/root /path/to/out/root --limit 5
    # then the full batch (long-running — run under nohup/tmux). 400k volumes sequentially
    # would take far too long, so this parallelizes across --workers processes:
    nohup python3 generate_profile_previews.py /mnt/data/all_cts /home/visitor/profiles \
        --workers 8 > /tmp/generate_profile_previews.log 2>&1 &
Idempotent: skips cases that already have profile.jpg unless --overwrite, so a killed/
resumed run just picks up where it left off.
"""
from __future__ import annotations

import argparse
import glob
import os
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed

import nibabel as nib
import nibabel.orientations as nio
import numpy as np
from PIL import Image
from tqdm import tqdm

PROFILE_NAME = "profile.jpg"
THUMB_SIZE = (512, 512)
# Bone window (HU): calibrated against the existing PanTS/CancerVerse profile.jpg output
# (scripts/make_profile_previews.py) so every dataset's cards look like the same product.
WINDOW_LO = 375
WINDOW_HI = 1300
_LPS = nio.axcodes2ornt(("L", "P", "S"))


def _coronal_mip_lps(ct_path: str) -> np.ndarray:
    """Bone-window coronal MIP, oriented head-up/patient-left-on-image-right (LPS).

    Reorients from EACH volume's own affine, so scans stored in different native
    orientations (e.g. mixing PanTS- and CancerVerse-style CTs) all come out upright the
    same way — no dataset-specific branching needed.
    """
    img = nib.load(ct_path)
    xfm = nio.ornt_transform(nio.io_orientation(img.affine), _LPS)
    data = nio.apply_orientation(np.asanyarray(img.dataobj), xfm).astype(np.float32)

    mip = np.clip(data, WINDOW_LO, WINDOW_HI).max(axis=1)  # project A->P, keep (L, S)
    frame = np.flipud(mip.T)  # rows=S (superior at top), cols=L
    norm = (frame - WINDOW_LO) / (WINDOW_HI - WINDOW_LO)
    return (norm * 255).astype(np.uint8)


def _case_id_for(ct_path: str, pattern: str) -> str:
    if any(ch in pattern for ch in "*?["):
        # Wildcard pattern — there's no per-case directory, so the filename IS the id.
        name = os.path.basename(ct_path)
        for suffix in (".nii.gz", ".nii"):
            if name.endswith(suffix):
                return name[: -len(suffix)]
        return os.path.splitext(name)[0]
    # Fixed filename (e.g. "ct.nii.gz") — one CT per case directory; the parent directory
    # name is the case id (matches make_profile_previews.py / make_lowres.py).
    return os.path.basename(os.path.dirname(ct_path))


def _process_one(ct_path: str, out_root: str, pattern: str, overwrite: bool) -> tuple[str, str]:
    case_id = _case_id_for(ct_path, pattern)
    out_path = os.path.join(out_root, "profile_only", case_id, PROFILE_NAME)
    if os.path.exists(out_path) and not overwrite:
        return ct_path, "skip"
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    try:
        arr8 = _coronal_mip_lps(ct_path)
        im = Image.fromarray(arr8).resize(THUMB_SIZE, resample=Image.BICUBIC).convert("RGB")
        im.save(out_path, format="JPEG", quality=90)
        return ct_path, "ok"
    except Exception as e:  # never let one bad file abort the batch
        return ct_path, f"err:{e}"


def main():
    ap = argparse.ArgumentParser(
        description="Generate profile-card thumbnails from a directory tree of CT scans."
    )
    ap.add_argument("root", help="directory to recursively search for CT volumes")
    ap.add_argument("out_root", help="writable dir for profile_only/<case>/profile.jpg output")
    ap.add_argument("--pattern", default="ct.nii.gz",
                     help="filename to match under --root, recursively; wildcards allowed "
                          "(default: ct.nii.gz)")
    ap.add_argument("--overwrite", action="store_true", help="regenerate even if profile.jpg exists")
    ap.add_argument("--limit", type=int, default=0, help="process at most N volumes (0 = all)")
    ap.add_argument("--workers", type=int, default=8,
                     help="parallel worker processes (default: 8). This is disk/IO-bound, "
                          "not CPU-bound — tune to your storage, not just core count.")
    args = ap.parse_args()

    if not os.path.isdir(args.root):
        sys.exit(f"root does not exist or is not a directory: {args.root}")
    if args.workers < 1:
        sys.exit("--workers must be >= 1")

    ct_paths = sorted(glob.glob(os.path.join(args.root, "**", args.pattern), recursive=True))
    if args.limit:
        ct_paths = ct_paths[: args.limit]

    print(f"Found {len(ct_paths)} CT volumes under {args.root} (pattern={args.pattern!r})")
    print(f"Writing profile thumbnails under {args.out_root}/profile_only/  (workers={args.workers})")
    if not ct_paths:
        print("Nothing to do — check --pattern / root.")
        return

    counts = {"ok": 0, "skip": 0, "err": 0}
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = [
            pool.submit(_process_one, ct, args.out_root, args.pattern, args.overwrite)
            for ct in ct_paths
        ]
        # mininterval keeps the redraw rate sane in a nohup log even at 400k volumes.
        with tqdm(total=len(ct_paths), unit="ct", mininterval=1.0) as bar:
            for fut in as_completed(futures):
                ct_path, result = fut.result()
                if result.startswith("err:"):
                    counts["err"] += 1
                    tqdm.write(f"  [err] {ct_path}: {result[4:]}")
                else:
                    counts[result] += 1
                bar.set_postfix(counts, refresh=False)
                bar.update(1)

    print(f"Done: {counts}")


if __name__ == "__main__":
    main()

      -> <root>/<case_id>/ct.nii.gz               (CancerVerse-style, flat)
    both resolve to the same <case_id>.
  - Wildcard pattern (e.g. --pattern '*.nii.gz'): the case id is the filename itself
    (without .nii/.nii.gz), since there's no per-case directory to read an id from.
Output always lands at:
    <out_root>/profile_only/<case_id>/profile.jpg

Usage (requires: nibabel, numpy, Pillow, tqdm):
    # quick trial run first:
    python3 generate_profile_previews.py /path/to/ct/root /path/to/out/root --limit 5
    # then the full batch (long-running — run under nohup/tmux). 400k volumes sequentially
    # would take far too long, so this parallelizes across --workers processes:
    nohup python3 generate_profile_previews.py /mnt/data/all_cts /home/visitor/profiles \
        --workers 8 > /tmp/generate_profile_previews.log 2>&1 &
Idempotent: skips cases that already have profile.jpg unless --overwrite, so a killed/
resumed run just picks up where it left off.
"""
from __future__ import annotations

import argparse
import glob
import os
import sys
from concurrent.futures import ProcessPoolExecutor, as_completed

import nibabel as nib
import nibabel.orientations as nio
import numpy as np
from PIL import Image
from tqdm import tqdm

PROFILE_NAME = "profile.jpg"
THUMB_SIZE = (512, 512)
# Bone window (HU): calibrated against the existing PanTS/CancerVerse profile.jpg output
# (scripts/make_profile_previews.py) so every dataset's cards look like the same product.
WINDOW_LO = 375
WINDOW_HI = 1300
_LPS = nio.axcodes2ornt(("L", "P", "S"))


def _coronal_mip_lps(ct_path: str) -> np.ndarray:
    """Bone-window coronal MIP, oriented head-up/patient-left-on-image-right (LPS).

    Reorients from EACH volume's own affine, so scans stored in different native
    orientations (e.g. mixing PanTS- and CancerVerse-style CTs) all come out upright the
    same way — no dataset-specific branching needed.
    """
    img = nib.load(ct_path)
    xfm = nio.ornt_transform(nio.io_orientation(img.affine), _LPS)
    data = nio.apply_orientation(np.asanyarray(img.dataobj), xfm).astype(np.float32)

    mip = np.clip(data, WINDOW_LO, WINDOW_HI).max(axis=1)  # project A->P, keep (L, S)
    frame = np.flipud(mip.T)  # rows=S (superior at top), cols=L
    norm = (frame - WINDOW_LO) / (WINDOW_HI - WINDOW_LO)
    return (norm * 255).astype(np.uint8)


def _case_id_for(ct_path: str, pattern: str) -> str:
    if any(ch in pattern for ch in "*?["):
        # Wildcard pattern — there's no per-case directory, so the filename IS the id.
        name = os.path.basename(ct_path)
        for suffix in (".nii.gz", ".nii"):
            if name.endswith(suffix):
                return name[: -len(suffix)]
        return os.path.splitext(name)[0]
    # Fixed filename (e.g. "ct.nii.gz") — one CT per case directory; the parent directory
    # name is the case id (matches make_profile_previews.py / make_lowres.py).
    return os.path.basename(os.path.dirname(ct_path))


def _process_one(ct_path: str, out_root: str, pattern: str, overwrite: bool) -> tuple[str, str]:
    case_id = _case_id_for(ct_path, pattern)
    out_path = os.path.join(out_root, "profile_only", case_id, PROFILE_NAME)
    if os.path.exists(out_path) and not overwrite:
        return ct_path, "skip"
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    try:
        arr8 = _coronal_mip_lps(ct_path)
        im = Image.fromarray(arr8).resize(THUMB_SIZE, resample=Image.BICUBIC).convert("RGB")
        im.save(out_path, format="JPEG", quality=90)
        return ct_path, "ok"
    except Exception as e:  # never let one bad file abort the batch
        return ct_path, f"err:{e}"


def main():
    ap = argparse.ArgumentParser(
        description="Generate profile-card thumbnails from a directory tree of CT scans."
    )
    ap.add_argument("root", help="directory to recursively search for CT volumes")
    ap.add_argument("out_root", help="writable dir for profile_only/<case>/profile.jpg output")
    ap.add_argument("--pattern", default="ct.nii.gz",
                     help="filename to match under --root, recursively; wildcards allowed "
                          "(default: ct.nii.gz)")
    ap.add_argument("--overwrite", action="store_true", help="regenerate even if profile.jpg exists")
    ap.add_argument("--limit", type=int, default=0, help="process at most N volumes (0 = all)")
    ap.add_argument("--workers", type=int, default=8,
                     help="parallel worker processes (default: 8). This is disk/IO-bound, "
                          "not CPU-bound — tune to your storage, not just core count.")
    args = ap.parse_args()

    if not os.path.isdir(args.root):
        sys.exit(f"root does not exist or is not a directory: {args.root}")
    if args.workers < 1:
        sys.exit("--workers must be >= 1")

    ct_paths = sorted(glob.glob(os.path.join(args.root, "**", args.pattern), recursive=True))
    if args.limit:
        ct_paths = ct_paths[: args.limit]

    print(f"Found {len(ct_paths)} CT volumes under {args.root} (pattern={args.pattern!r})")
    print(f"Writing profile thumbnails under {args.out_root}/profile_only/  (workers={args.workers})")
    if not ct_paths:
        print("Nothing to do — check --pattern / root.")
        return

    counts = {"ok": 0, "skip": 0, "err": 0}
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futures = [
            pool.submit(_process_one, ct, args.out_root, args.pattern, args.overwrite)
            for ct in ct_paths
        ]
        # mininterval keeps the redraw rate sane in a nohup log even at 400k volumes.
        with tqdm(total=len(ct_paths), unit="ct", mininterval=1.0) as bar:
            for fut in as_completed(futures):
                ct_path, result = fut.result()
                if result.startswith("err:"):
                    counts["err"] += 1
                    tqdm.write(f"  [err] {ct_path}: {result[4:]}")
                else:
                    counts[result] += 1
                bar.set_postfix(counts, refresh=False)
                bar.update(1)

    print(f"Done: {counts}")


if __name__ == "__main__":
    main()
