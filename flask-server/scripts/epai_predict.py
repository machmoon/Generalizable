#!/usr/bin/env python3
"""Optimized ePAI inference: warm persistent predictor + GPU-resident export.

services/auto_segmentor.py, wired in via the EPAI_SCRIPT_PATH hook (which invokes:
`bash <script> session_dir case_id input_dir save_dir input_csv output_csv ckpt_path`).

Two execution paths, same pattern as scripts/lesionseg_predict.py:

1. WARM (fast). If EPAI_WARM_URL is set and that service is healthy, the work is
   handed to the persistent predictor (scripts/epai_warm_server.py), which holds
   the model in GPU memory across requests -- skipping the cold-start subprocess
   reload (interpreter + torch import + checkpoint load + cuDNN autotune) this
   script otherwise pays on EVERY request. Everything above the fallback below is
   stdlib-only; the heavy imports live inside _cold_predict so the warm path
   never pays their cost either.

2. COLD (fallback). Load the model in-process and run, exactly as before. Used
   when no warm URL is configured, the service is down, or it is running a
   different configuration than the caller asked for. Deliberate: the website
   must keep working if the warm service dies, just more slowly.

Why this wrapper exists at all instead of the bare CLI: the CLI has no flag for
GPU-accelerated export resampling. Swapping ConfigurationManager.resampling_fn_
probabilities for resample_torch_fornnunet cuts that stage from ~158s of CPU
resampling to ~0.3s (measured ~50-55x at 500-case scale, voxel agreement
0.99996+) with no accuracy cost.

Three fork-specific fixes vs the standard-nnU-Net LesionSegmenter wrapper (this
runs inside the `epai` conda env, where `import nnunetv2` resolves to qchen76's
fork, not vanilla nnU-Net):
  1. determine_do_sep_z_and_axis in the fork returns the anisotropy axis as a
     bare scalar on the separate-z path, so resample_torch's `assert
     len(axis)==1` crashes (standard nnU-Net returns a 1-element list). Coerce
     scalar -> [int(axis)].
  2. This model's plans specify NibabelIOWithReorient as the reader/writer
     class, not SimpleITKIO. Reading with the wrong class produces a properties
     dict missing 'nibabel_stuff', which the nibabel writer needs for the
     reoriented affine -> KeyError deep inside write_seg. Must read with
     plans_manager.image_reader_writer_class(), not a hardcoded reader.
  3. export_prediction_from_logits's entire write path (segmentation file,
     tumor-stats extraction, output-CSV update) lives inside `if
     save_probabilities:` in this fork -- the unconditional write that used to
     run regardless is commented out (a leftover from whatever refactor added
     the CSV pipeline). save_probabilities=False looks like the obviously
     correct choice (we don't want a probabilities.npz -- that branch is itself
     commented out, "we don't save probabilities as pickles anymore") but
     actually means "write nothing at all," silently: rc=0, no exception, zero
     bytes written. MUST be True.
All three found and fixed via direct smoke test (3 cases: small/medium/a
1060-slice large volume, all producing real segmentation files and fully
populated findings CSV rows) before this was ever wired into EPAI_SCRIPT_PATH.
"""
import json
import os
import sys
import urllib.error
import urllib.request


def _warm_predict(case_id, input_dir, output_dir, output_csv, step_size, disable_tta, tta_axes,
                  url, timeout):
    """Try the persistent predictor. Returns True if it produced the output.

    Mirrors lesionseg_predict.py's _warm_predict: any failure returns False so
    the caller falls back to cold inference. A warm service that is down, busy,
    or differently configured must degrade to a slow correct answer, never to a
    wrong or missing one.
    """
    base = url.rstrip("/")
    try:
        with urllib.request.urlopen(f"{base}/health", timeout=5) as r:
            health = json.loads(r.read())
    except Exception as e:
        print(f"[warm] health check failed ({e}); using cold path", flush=True)
        return False

    health_axes = health.get("tta_axes")
    if abs(float(health.get("step_size", -1)) - float(step_size)) > 1e-9 \
            or bool(health.get("disable_tta")) != bool(disable_tta) \
            or (health_axes is not None) != (tta_axes is not None) \
            or (tta_axes is not None and list(health_axes or []) != list(tta_axes)):
        print(f"[warm] config mismatch (server step={health.get('step_size')} "
              f"disable_tta={health.get('disable_tta')} tta_axes={health_axes}; "
              f"requested step={step_size} disable_tta={disable_tta} tta_axes={tta_axes}); "
              f"using cold path", flush=True)
        return False

    root = health.get("allowed_root")
    if not root:
        print("[warm] server did not report allowed_root; using cold path", flush=True)
        return False
    try:
        rel_in = os.path.relpath(os.path.realpath(input_dir), root)
        rel_out = os.path.relpath(os.path.realpath(output_dir), root)
        rel_csv = os.path.relpath(os.path.realpath(output_csv), root)
    except ValueError as e:
        print(f"[warm] cannot relativise paths against {root} ({e}); using cold path", flush=True)
        return False
    if any(r == os.pardir or r.startswith(os.pardir + os.sep) or os.path.isabs(r)
           for r in (rel_in, rel_out, rel_csv)):
        print(f"[warm] paths are outside the server root {root}; using cold path", flush=True)
        return False

    body = json.dumps({
        "case_id": case_id,
        "input_rel": rel_in.replace(os.sep, "/"),
        "output_rel": rel_out.replace(os.sep, "/"),
        "output_csv_rel": rel_csv.replace(os.sep, "/"),
        "step_size": float(step_size),
        "disable_tta": bool(disable_tta),
        "tta_axes": list(tta_axes) if tta_axes is not None else None,
    }).encode()
    req = urllib.request.Request(f"{base}/predict", data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            resp = json.loads(r.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:400]
        print(f"[warm] server returned {e.code}: {detail}; using cold path", flush=True)
        return False
    except Exception as e:
        print(f"[warm] request failed ({e}); using cold path", flush=True)
        return False

    for item in resp.get("results", []):
        out = item.get("output_path")
        if not out or not os.path.exists(out):
            print(f"[warm] server reported success but {out} is missing; using cold path",
                  flush=True)
            return False
        print(f"done {item.get('case_id')} ({item.get('seconds')}s, warm)", flush=True)
    if not resp.get("results"):
        print("[warm] server returned no results; using cold path", flush=True)
        return False
    return True


def _cold_predict(case_id, input_dir, save_dir, output_csv, ckpt_path):
    """In-process inference. Heavy imports are local so the warm path never pays them."""
    from functools import partial

    import numpy as np
    import torch
    from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor
    from nnunetv2.preprocessing.preprocessors.default_preprocessor import DefaultPreprocessor
    from nnunetv2.inference.export_prediction import export_prediction_from_logits
    from nnunetv2.preprocessing.resampling.resample_torch import resample_torch_fornnunet
    import nnunetv2.preprocessing.resampling.resample_torch as _rt
    import nnunetv2.utilities.plans_handling.plans_handler as _ph

    def _apply_fork_fixes():
        # (1) coerce the anisotropy axis back to a list -- see module docstring, fix 1.
        _orig_determine = _rt.determine_do_sep_z_and_axis

        def _fixed_determine(*a, **k):
            do_sep, axis = _orig_determine(*a, **k)
            if do_sep and np.isscalar(axis):
                axis = [int(axis)]
            return do_sep, axis

        _rt.determine_do_sep_z_and_axis = _fixed_determine

        # (2) GPU-resident probabilities resampling (the ~158s -> ~0.3s export lever)
        _ph.ConfigurationManager.resampling_fn_probabilities = property(
            lambda self: partial(resample_torch_fornnunet, device=torch.device("cuda"), is_seg=False)
        )

    if not torch.cuda.is_available():
        print("ERROR: CUDA not available", file=sys.stderr)
        sys.exit(1)

    _apply_fork_fixes()

    disable_tta = os.getenv("EPAI_DISABLE_TTA", "0").strip().lower() in {"1", "true", "yes", "on"}
    predictor = nnUNetPredictor(
        tile_step_size=float(os.getenv("EPAI_STEP_SIZE", "0.5")),
        use_mirroring=not disable_tta,
        perform_everything_on_device=True,
        device=torch.device("cuda"),
        allow_tqdm=False,
        verbose=False,
    )
    predictor.initialize_from_trained_model_folder(
        ckpt_path, use_folds=("all",),
        checkpoint_name=os.getenv("EPAI_CHECKPOINT_NAME", "checkpoint_final.pth"),
    )
    tta_axes_raw = os.getenv("EPAI_TTA_AXES", "").strip()
    if tta_axes_raw and not disable_tta:
        predictor.allowed_mirroring_axes = tuple(int(x) for x in tta_axes_raw.split(","))

    pp = DefaultPreprocessor(verbose=False)
    pm, cm = predictor.plans_manager, predictor.configuration_manager
    # Must match the writer export_prediction_from_logits uses internally -- see
    # module docstring, fix 2. Reading with SimpleITKIO produces a properties
    # dict missing 'nibabel_stuff', which the nibabel writer needs.
    rw = pm.image_reader_writer_class()

    ct = os.path.join(input_dir, f"{case_id}_0000.nii.gz")
    if not os.path.exists(ct):
        print(f"ERROR: input not found: {ct}", file=sys.stderr)
        sys.exit(1)

    data, props = rw.read_images([ct])
    dpp, _, pprops = pp.run_case_npy(data, None, props, pm, cm, predictor.dataset_json)
    logits = predictor.predict_logits_from_preprocessed_data(torch.from_numpy(dpp))

    # save_probabilities MUST be True -- see module docstring, fix 3.
    out_trunc = os.path.join(save_dir, case_id)
    export_prediction_from_logits(
        logits, pprops, cm, pm, predictor.dataset_json, out_trunc,
        save_probabilities=True, output_csv_path=output_csv,
    )
    print(f"done {case_id}", flush=True)


def main():
    # Positional contract from services/auto_segmentor.py's EPAI_SCRIPT_PATH hook.
    if len(sys.argv) < 8:
        print("usage: epai_predict.py session_dir case_id input_dir save_dir "
              "input_csv output_csv ckpt_path", file=sys.stderr)
        sys.exit(2)
    _session_dir, case_id, input_dir, save_dir, _input_csv, output_csv, ckpt_path = sys.argv[1:8]

    os.makedirs(save_dir, exist_ok=True)

    step_size = float(os.getenv("EPAI_STEP_SIZE", "0.5"))
    disable_tta = os.getenv("EPAI_DISABLE_TTA", "0").strip().lower() in {"1", "true", "yes", "on"}
    tta_axes_raw = os.getenv("EPAI_TTA_AXES", "").strip()
    tta_axes = tuple(int(x) for x in tta_axes_raw.split(",")) if tta_axes_raw else None

    warm_url = os.getenv("EPAI_WARM_URL", "").strip()
    if warm_url:
        timeout = int(os.getenv("EPAI_WARM_TIMEOUT", "3600"))
        if _warm_predict(case_id, input_dir, save_dir, output_csv, step_size, disable_tta,
                         tta_axes, warm_url, timeout):
            return

    _cold_predict(case_id, input_dir, save_dir, output_csv, ckpt_path)


if __name__ == "__main__":
    main()
