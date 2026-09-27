#!/usr/bin/env python3
"""
Offline batch job: generate low-resolution copies of the dataset volumes so the web
viewer can load a small version first (instant interaction) and fetch full resolution
only on demand ("HD"). Meant to run on the JHU server, which has the data + the
hardware — it's CPU/disk only, no new infrastructure.

The dataset mount is READ-ONLY, so the low-res copies are written under a separate
writable --out-root (default /home/visitor/pants_lowres, or $PANTS_LOWRES_PATH),
mirroring the dataset layout so the API can find them:
    <out_root>/image_only/<case>/ct_lowres.nii.gz               (linear, order=1)
    <out_root>/mask_only/<case>/combined_labels_lowres.nii.gz    (nearest, order=0)

CT and segmentation are downsampled by the SAME --factor so they stay geometrically
aligned (the viewer overlays them) — at low res the relationship is identical to full
res, so the overlay can't break. Both files are written together per case (or neither),
so the API never ends up serving a low-res CT against a full-res mask.

Fully additive + reversible: if the *_lowres.nii.gz files are absent, the API serves
the originals exactly as before. Delete the --out-root tree to revert.

Usage (on the server — use the conda python that runs the backend):
    PYBIN=/home/visitor/.conda/envs/PanTS_backend/bin/python3.11
    cd flask-server
    # quick trial run first:
    $PYBIN scripts/make_lowres.py --factor 2 --limit 5
    # then the full batch (long-running — run under nohup/tmux):
    nohup $PYBIN scripts/make_lowres.py --factor 2 > /tmp/make_lowres.log 2>&1 &
Idempotent: skips cases that already have low-res files unless --overwrite.
"""
import argparse
import glob
import os
import sys
import time

import nibabel as nib
import numpy as np
from scipy.ndimage import zoom

# Import the app's constants (PANTS_PATH, filenames) from the flask-server root.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from constants import Constants  # noqa: E402

CT_NAME = "ct.nii.gz"
SEG_NAME = "combined_labels.nii.gz"
CT_LOW = "ct_lowres.nii.gz"
SEG_LOW = "combined_labels_lowres.nii.gz"


def _downsample(img, factor, order):
    """Return (data, affine) downsampled by `factor` per axis, preserving world extent."""
    # Preserve source dtype where possible. get_fdata() always expands to float64,
    # which can multiply memory use for full-body CTs during a 500-case batch.
    data = np.asanyarray(img.dataobj)
    out = zoom(data, 1.0 / factor, order=order)
    new_affine = img.affine.copy()
    # voxels are now `factor`x larger, so scale the voxel->world matrix to match.
    new_affine[:3, :3] = img.affine[:3, :3] * factor
    return out, new_affine


def _seg_path_for(ct_path):
    """Map .../image_only/<id>/ct.nii.gz -> .../mask_only/<id>/combined_labels.nii.gz."""
    p = ct_path.replace(f"{os.sep}image_only{os.sep}", f"{os.sep}mask_only{os.sep}")
    return p.replace(CT_NAME, SEG_NAME)


def _process_case(ct_path, out_root, factor, overwrite):
    seg_path = _seg_path_for(ct_path)
    if not os.path.exists(seg_path):
        return "no_seg"  # skip entirely so we never pair low CT with full mask

    # Write under out_root, mirroring image_only/<case>/ + mask_only/<case>/ so the
    # API (LOWRES_ROOT) can find them. The dataset mount itself is read-only.
    case_id = os.path.basename(os.path.dirname(ct_path))
    ct_low = os.path.join(out_root, "image_only", case_id, CT_LOW)
    seg_low = os.path.join(out_root, "mask_only", case_id, SEG_LOW)
    if os.path.exists(ct_low) and os.path.exists(seg_low) and not overwrite:
        return "skip"
    os.makedirs(os.path.dirname(ct_low), exist_ok=True)
    os.makedirs(os.path.dirname(seg_low), exist_ok=True)

    # CT: linear interpolation, keep int16 Hounsfield units.
    ct_img = nib.load(ct_path)
    ct_data, ct_aff = _downsample(ct_img, factor, order=1)
    ct_out = nib.Nifti1Image(np.rint(ct_data).astype(np.int16), ct_aff)
    ct_out.set_data_dtype(np.int16)

    # Segmentation: nearest-neighbour so label ids are preserved exactly.
    seg_img = nib.load(seg_path)
    seg_data, seg_aff = _downsample(seg_img, factor, order=0)
    seg_out = nib.Nifti1Image(seg_data.astype(np.uint8), seg_aff)
    seg_out.set_data_dtype(np.uint8)

    nib.save(ct_out, ct_low)
    nib.save(seg_out, seg_low)
    return "ok"


def main():
    default_out = os.environ.get("PANTS_LOWRES_PATH", "/home/visitor/pants_lowres")
    ap = argparse.ArgumentParser(description="Generate low-res CT + seg copies.")
    ap.add_argument("--factor", type=float, default=2.0, help="downsample factor per axis (>=1)")
    ap.add_argument("--out-root", default=default_out,
                    help=f"writable dir for low-res output (default: {default_out})")
    ap.add_argument("--overwrite", action="store_true", help="regenerate even if low-res exists")
    ap.add_argument("--limit", type=int, default=0, help="process at most N cases (0 = all)")
    args = ap.parse_args()

    if not Constants.PANTS_PATH:
        sys.exit("PANTS_PATH not set — check flask-server/.env")
    if args.factor < 1:
        sys.exit("--factor must be >= 1")

    # CT volumes live under <PANTS_PATH>/image_only/<case>/ct.nii.gz (masks are in the
    # parallel mask_only/ tree — see _seg_path_for).
    root = os.path.join(Constants.PANTS_PATH, "image_only")
    ct_paths = sorted(glob.glob(os.path.join(root, "*", CT_NAME)))
    if args.limit:
        ct_paths = ct_paths[: args.limit]

    print(f"Found {len(ct_paths)} CT volumes under {root} (factor={args.factor})")
    print(f"Writing low-res copies under {args.out_root}")
    counts = {"ok": 0, "skip": 0, "no_seg": 0, "err": 0}
    t0 = time.time()
    for i, ct in enumerate(ct_paths, 1):
        try:
            result = _process_case(ct, args.out_root, args.factor, args.overwrite)
        except Exception as e:  # never let one bad file abort the batch
            result = "err"
            print(f"  [err] {ct}: {e}")
        counts[result] += 1
        if i % 25 == 0 or i == len(ct_paths):
            print(f"  {i}/{len(ct_paths)}  ok={counts['ok']} skip={counts['skip']} "
                  f"no_seg={counts['no_seg']} err={counts['err']}  ({time.time()-t0:.0f}s)")

    print(f"Done: {counts}")


if __name__ == "__main__":
    main()
