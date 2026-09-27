#!/usr/bin/env python
"""Print exactly what is in a case's segmentation, and what the assistant sees.

Run this when an answer looks wrong. It reports the resolved labelmap path,
every label present with its voxel count and volume, and the lesion analysis —
so a wrong answer can be traced to the data or to the code in one step.

    python scripts/diagnose_case_labels.py 17
    python scripts/diagnose_case_labels.py <session-id>
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np  # noqa: E402
import nibabel as nib  # noqa: E402

from services.mesh_generation import LABELS as MESH_LABELS  # noqa: E402
from services import lesion_grounding  # noqa: E402


def main(case_id: str) -> int:
    from api.api_blueprint import _ai_mask_path_for

    path = _ai_mask_path_for(case_id)
    print(f"case id     : {case_id}")
    print(f"labelmap    : {path or 'NOT FOUND'}")
    if not path or not os.path.exists(path):
        print("\nNo labelmap resolved. For a dataset case check PANTS_PATH; for an "
              "upload check that inference finished and wrote combined_labels.nii.gz.")
        return 1

    image = nib.load(path)
    data = np.rint(np.asanyarray(image.dataobj)).astype(np.int32)
    zooms = [abs(float(z)) for z in image.header.get_zooms()[:3]]
    voxel_mm3 = float(np.prod(zooms))
    print(f"shape       : {data.shape}")
    print(f"voxel size  : {zooms} mm  ({voxel_mm3:.4f} mm^3)")
    print(f"orientation : {nib.aff2axcodes(image.affine)}")

    print("\n--- labels present ---")
    flat = data.reshape(-1)
    counts = np.bincount(flat[flat > 0])
    if not counts.size:
        print("  (labelmap is empty)")
    for label_id in np.nonzero(counts)[0]:
        label_id = int(label_id)
        voxels = int(counts[label_id])
        meta = MESH_LABELS.get(label_id)
        name = meta["name"] if meta else "UNKNOWN LABEL — not in the viewer scheme"
        print(f"  {label_id:>3}  {name:<32} {voxels:>10} voxels"
              f"  {voxels * voxel_mm3 / 1000.0:>10.2f} cm3")

    print("\n--- lesion analysis (what the assistant reports) ---")
    analysis = lesion_grounding.analyze_lesions(path, cache_key=str(case_id))
    if not analysis.get("available"):
        print(f"  unavailable: {analysis.get('reason')}")
    else:
        for entry in analysis["lesions"]:
            if not entry.get("present"):
                print(f"  {entry['display']}: absent")
                continue
            flag = "  [SCATTERED — no single location reported]" if entry.get("diffuse") else ""
            print(f"  {entry['display']}: present, {entry['volume_cm3']:.2f} cm3, "
                  f"{entry.get('foci', 1)} foci{flag}")
            if not entry.get("diffuse"):
                print(f"      region={entry.get('region')} slice={entry.get('axial_slice')} "
                      f"range={entry.get('slice_range')} max_dim={entry.get('max_diameter_mm')}mm "
                      f"contacts={entry.get('contacts', [])}")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
