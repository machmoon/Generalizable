#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.9"
# dependencies = ["numpy", "nibabel", "pillow"]
# ///
"""Build Lumen's bundled case library (ios/Lumen/Resources/Cases/<CASE_ID>/).

Per case:
  ct.nii.gz               int16 HU, RAS+ closest canonical, largest dim <= 256 (block mean)
  combined_labels.nii.gz  uint8 labels, same grid (block mode; never averaged)
  profile.jpg             HF profile_only thumbnail, else a rendered mid-coronal W400/L40 + overlay
  stats.json              per-organ voxels, mL (original resolution), centroid/bbox (bundled
                          canonical voxel coords), mean/std HU (original resolution)
Plus Cases/index.json.

Usage:
  uv run ios/tools/prepare_cases.py                 # all scans in ../scans, downsampled
  uv run ios/tools/prepare_cases.py --full          # copy originals verbatim (no reorient/downsample)
  uv run ios/tools/prepare_cases.py --only PanTS_00008205 --max-dim 256
  (or: python3 prepare_cases.py with numpy/nibabel/pillow installed)

Prior art (read before writing):
  - nibabel/funcs.py `as_closest_canonical` -> used directly for RAS+ reorientation
    (https://github.com/nipy/nibabel/blob/master/nibabel/funcs.py).
  - TotalSegmentator totalsegmentator/resampling.py `change_spacing` / `change_spacing_of_affine`
    (https://github.com/wasserth/TotalSegmentator/blob/master/totalsegmentator/resampling.py):
    labels resampled with order=0 (nearest), image with interpolation, affine columns scaled
    by the zoom. Deviation: we use integer per-axis block reduction (area average for CT, block
    mode for labels) instead of scipy.ndimage.zoom, because an integer factor keeps the affine
    exact (scale columns by f, shift origin by (f-1)/2 voxel) and area averaging anti-aliases.
    Labels that would vanish under the mode (tiny lesions) are rescued into the blocks where
    they are most frequent, so every organ present in the original survives in the bundle.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
import urllib.request
from pathlib import Path

import nibabel as nib
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]            # BodyMaps-website/
SCANS = ROOT / "scans"
OUT = ROOT / "ios" / "Lumen" / "Resources" / "Cases"
HERO = "PanTS_00008205"
HF_PROFILE = "https://huggingface.co/datasets/BodyMaps/iPanTSMini/resolve/main/profile_only/{id}/profile.jpg"

# Organ ids 1..35 == order of Organ.keys in ios/Lumen/Core/Contracts.swift
ORGAN_KEYS = [
    "adrenal_gland_left", "adrenal_gland_right", "aorta", "bladder", "celiac_artery",
    "colon", "common_bile_duct", "duodenum", "femur_left", "femur_right", "gall_bladder",
    "kidney_left", "kidney_right", "liver", "lung_left", "lung_right", "pancreas",
    "pancreas_body", "pancreas_head", "pancreas_tail", "pancreatic_duct",
    "pancreatic_lesion", "postcava", "prostate", "spleen", "stomach",
    "superior_mesenteric_artery", "veins", "intestine", "renal_vein_left",
    "renal_vein_right", "cbd_stent", "liver_lesion", "kidney_lesion", "colon_lesion",
]
ORGAN_RGB = [
    (255, 140, 0), (255, 165, 0), (255, 0, 0), (0, 191, 255), (220, 20, 60), (255, 160, 255),
    (34, 139, 34), (255, 127, 80), (245, 245, 245), (220, 220, 220), (0, 128, 0), (68, 229, 133),
    (68, 229, 181), (178, 34, 34), (68, 181, 229), (68, 133, 229), (255, 182, 193), (255, 105, 180),
    (219, 112, 147), (255, 160, 122), (255, 228, 181), (80, 0, 0), (72, 61, 139), (255, 105, 180),
    (138, 43, 226), (255, 99, 71), (255, 69, 0), (106, 90, 205), (255, 200, 120), (100, 149, 237),
    (70, 130, 180), (192, 192, 192), (255, 140, 0), (255, 215, 0), (220, 20, 60),
]


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- resampling

def factors_for(shape, max_dim):
    return tuple(max(1, -(-int(s) // max_dim)) for s in shape)   # ceil(s / max_dim)


def crop_to_multiple(a, f):
    return a[tuple(slice(0, (s // k) * k) for s, k in zip(a.shape, f))]


def block_view(a, f):
    nx, ny, nz = (s // k for s, k in zip(a.shape, f))
    return a.reshape(nx, f[0], ny, f[1], nz, f[2])


def block_mean_int16(ct, f):
    if f == (1, 1, 1):
        return ct.astype(np.int16)
    c = crop_to_multiple(ct, f)
    m = block_view(c.astype(np.float32), f).mean(axis=(1, 3, 5))
    return np.clip(np.rint(m), -32768, 32767).astype(np.int16)


def block_mode_uint8(lab, f):
    """Majority label per block (background included); rescue labels the mode would erase."""
    if f == (1, 1, 1):
        return lab.astype(np.uint8)
    c = crop_to_multiple(lab, f)
    present = [int(k) for k in np.unique(c) if k != 0]
    out_shape = tuple(s // k for s, k in zip(c.shape, f))
    best = np.zeros(out_shape, np.uint8)
    best_n = block_view((c == 0), f).sum(axis=(1, 3, 5), dtype=np.int16)
    counts = {}
    for k in present:
        n = block_view((c == k), f).sum(axis=(1, 3, 5), dtype=np.int16)
        counts[k] = n
        win = n > best_n
        best[win] = k
        best_n = np.where(win, n, best_n)
    for k in present:                                   # rescue vanished structures
        if not (best == k).any():
            n = counts[k]
            best[n == n.max()] = k
    return best


def downsampled_affine(aff, f):
    A = aff.copy()
    fv = np.array(f, float)
    A[:3, :3] = aff[:3, :3] * fv[None, :]
    A[:3, 3] = aff[:3, :3] @ ((fv - 1) / 2) + aff[:3, 3]   # new voxel 0 = centre of old block 0
    return A


def make_img(data, affine, template_hdr, dtype):
    hdr = template_hdr.copy()
    hdr.set_data_dtype(dtype)
    img = nib.Nifti1Image(data.astype(dtype), affine, hdr)
    img.set_qform(affine, code=1)
    img.set_sform(affine, code=1)
    img.header.set_zooms(tuple(float(z) for z in np.sqrt((affine[:3, :3] ** 2).sum(0))))
    img.header["scl_slope"] = 1.0
    img.header["scl_inter"] = 0.0
    return img


# ---------------------------------------------------------------- thumbnail

def render_thumbnail(ct, lab, spacing, path, size=384):
    """Mid-coronal slice, W400/L40, organ overlay at 45%; radiological (patient R on left, S up)."""
    y = ct.shape[1] // 2
    if lab is not None and (lab > 0).any():
        y = int(np.round(np.nonzero(lab > 0)[1].mean()))
    sl = ct[:, y, :].astype(np.float32)                  # (x, z)
    g = np.clip((sl - (40 - 200)) / 400.0, 0, 1) * 255
    rgb = np.repeat(g[..., None], 3, axis=2)
    if lab is not None:
        ls = lab[:, y, :]
        pal = np.zeros((256, 3), np.float32)
        pal[1:36] = ORGAN_RGB
        m = ls > 0
        rgb[m] = rgb[m] * 0.55 + pal[ls[m]] * 0.45
    # to screen: rows = z descending (superior up), cols = x descending (patient right on left)
    img = rgb.transpose(1, 0, 2)[::-1, ::-1]
    h_mm, w_mm = ct.shape[2] * spacing[2], ct.shape[0] * spacing[0]
    im = Image.fromarray(img.astype(np.uint8))
    scale = size / max(h_mm, w_mm)
    im = im.resize((max(1, round(w_mm * scale)), max(1, round(h_mm * scale))), Image.BILINEAR)
    canvas = Image.new("RGB", (size, size), (0, 0, 0))
    canvas.paste(im, ((size - im.width) // 2, (size - im.height) // 2))
    canvas.save(path, "JPEG", quality=85)


def fetch_profile(case_id, path, tries=3):
    url = HF_PROFILE.format(id=case_id)
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "lumen-prepare-cases"})
            with urllib.request.urlopen(req, timeout=20) as r:
                data = r.read()
            if data[:2] == b"\xff\xd8":
                path.write_bytes(data)
                return True
            return False
        except Exception as e:  # noqa: BLE001
            code = getattr(e, "code", None)
            if code == 404:
                return False
            time.sleep(2 * (i + 1))
    return False


# ---------------------------------------------------------------- stats

def organ_stats(lab_full, ct_full, voxel_ml, lab_small):
    out = {}
    flat_l = lab_full.ravel()
    flat_c = ct_full.ravel().astype(np.float64)
    n = np.bincount(flat_l, minlength=256)
    s1 = np.bincount(flat_l, weights=flat_c, minlength=256)
    s2 = np.bincount(flat_l, weights=flat_c * flat_c, minlength=256)
    for k in range(1, 36):
        if n[k] == 0:
            continue
        mean = s1[k] / n[k]
        std = float(np.sqrt(max(0.0, s2[k] / n[k] - mean * mean)))
        e = {"id": k, "key": ORGAN_KEYS[k - 1], "voxels": int(n[k]),
             "volumeML": round(float(n[k] * voxel_ml), 3),
             "meanHU": round(float(mean), 1), "stdHU": round(std, 1)}
        idx = np.nonzero(lab_small == k)
        if len(idx[0]):
            e["bundledVoxels"] = int(len(idx[0]))
            e["centroid"] = [round(float(a.mean()), 2) for a in idx]
            e["bboxMin"] = [int(a.min()) for a in idx]
            e["bboxMax"] = [int(a.max()) for a in idx]
        out[ORGAN_KEYS[k - 1]] = e
    return out


# ---------------------------------------------------------------- main

def title_for(case_id):
    return f"Case {int(case_id.split('_')[-1])}"


def process(case_dir, out_root, max_dim, full):
    cid = case_dir.name
    dst = out_root / cid
    dst.mkdir(parents=True, exist_ok=True)
    ct_path, lab_path = case_dir / "ct.nii.gz", case_dir / "combined_labels.nii.gz"
    has_labels = lab_path.exists()
    t0 = time.time()

    ct_img = nib.as_closest_canonical(nib.load(ct_path))
    ct_full = np.asanyarray(ct_img.dataobj)                    # scl applied if slope != 1
    ct_full = np.clip(np.rint(ct_full), -32768, 32767).astype(np.int16)
    orig_spacing = np.sqrt((ct_img.affine[:3, :3] ** 2).sum(0))
    voxel_ml = float(np.prod(orig_spacing)) / 1000.0
    lab_full = None
    if has_labels:
        lab_img = nib.as_closest_canonical(nib.load(lab_path))
        lab_full = np.asanyarray(lab_img.dataobj).astype(np.int16)
        if lab_full.shape != ct_full.shape:
            raise SystemExit(f"{cid}: label shape {lab_full.shape} != ct {ct_full.shape}")
        lab_full = np.clip(lab_full, 0, 255).astype(np.uint8)

    if full:
        shutil.copy2(ct_path, dst / "ct.nii.gz")
        if has_labels:
            shutil.copy2(lab_path, dst / "combined_labels.nii.gz")
        f = (1, 1, 1)
        ct_s, lab_s, aff = ct_full, lab_full, ct_img.affine
    else:
        f = factors_for(ct_full.shape, max_dim)
        ct_s = block_mean_int16(ct_full, f)
        lab_s = block_mode_uint8(lab_full, f) if has_labels else None
        aff = downsampled_affine(ct_img.affine, f)
        nib.save(make_img(ct_s, aff, ct_img.header, np.int16), dst / "ct.nii.gz")
        if has_labels:
            nib.save(make_img(lab_s, aff, ct_img.header, np.uint8), dst / "combined_labels.nii.gz")

    spacing = [round(float(v), 6) for v in np.sqrt((aff[:3, :3] ** 2).sum(0))]
    dims = [int(v) for v in ct_s.shape]

    thumb = dst / "profile.jpg"
    src = "huggingface"
    if not fetch_profile(cid, thumb):
        render_thumbnail(ct_s, lab_s, spacing, thumb)
        src = "rendered"

    organs = organ_stats(lab_full, ct_full, voxel_ml, lab_s) if has_labels else {}
    stats = {
        "id": cid, "title": title_for(cid), "dims": dims, "spacing": spacing,
        "originalDims": [int(v) for v in ct_full.shape],
        "originalSpacing": [round(float(v), 6) for v in orig_spacing],
        "downsampleFactor": list(f), "affine": [[round(float(v), 6) for v in r] for r in aff],
        "orientation": "RAS", "thumbnail": src,
        "note": "voxels/volumeML/meanHU/stdHU at original resolution; centroid/bbox in bundled "
                "canonical voxel coords (x,y,z); organ id = index in Organ.keys + 1",
        "organs": organs,
    }
    (dst / "stats.json").write_text(json.dumps(stats, indent=1))
    size = sum(p.stat().st_size for p in dst.iterdir())
    log(f"{cid}: {tuple(ct_full.shape)} -> {tuple(dims)} f={f} spacing={spacing} "
        f"organs={len(organs)} thumb={src} {size/1e6:.1f}MB ({time.time()-t0:.1f}s)")
    return {"id": cid, "title": title_for(cid), "dims": dims, "spacing": spacing,
            "hasLabels": has_labels, "organs": list(organs.keys()), "hero": cid == HERO}, size


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--scans", type=Path, default=SCANS)
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--max-dim", type=int, default=256)
    ap.add_argument("--full", action="store_true", help="copy originals, no downsample")
    ap.add_argument("--only", nargs="*", help="case ids to process")
    args = ap.parse_args()

    cases = sorted(d for d in args.scans.iterdir() if (d / "ct.nii.gz").exists())
    if args.only:
        cases = [d for d in cases if d.name in args.only]
    cases.sort(key=lambda d: (d.name != HERO, d.name))          # hero first
    args.out.mkdir(parents=True, exist_ok=True)

    index_path = args.out / "index.json"
    prev = {}
    if index_path.exists():
        try:
            prev = {e["id"]: e for e in json.loads(index_path.read_text())}
        except Exception:  # noqa: BLE001
            prev = {}
    total = 0
    for d in cases:
        entry, size = process(d, args.out, args.max_dim, args.full)
        prev[entry["id"]] = entry
        total += size
    index = sorted(prev.values(), key=lambda e: (e["id"] != HERO, e["id"]))
    index_path.write_text(json.dumps(index, indent=1))
    bundle = sum(p.stat().st_size for p in args.out.rglob("*") if p.is_file())
    log(f"\n{len(cases)} case(s) processed, {total/1e6:.1f}MB written; "
        f"bundle total {bundle/1e6:.1f}MB; index -> {index_path}")
    if bundle > 80e6:
        log("WARNING: bundle exceeds ~80MB budget; try --max-dim 192")


if __name__ == "__main__":
    sys.exit(main())
