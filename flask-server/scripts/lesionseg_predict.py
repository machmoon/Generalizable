#!/usr/bin/env python3
"""
Thin nnU-Net inference wrapper for LesionSegmenter, invoked as a subprocess with a CLI
shape that mirrors nnUNetv2_predict_from_modelfolder (-i/-o/-m/-step_size/--disable_tta),
so it's a near drop-in replacement for the CLI call in services/auto_segmentor.py.

Two execution paths:

1. WARM (fast). If LESIONSEG_WARM_URL is set and that service is healthy, the work is
   handed to the persistent predictor (scripts/lesionseg_warm_server.py), which holds
   the model in GPU memory across requests. This skips the ~19s of interpreter start,
   torch import, checkpoint load and cuDNN autotune that the cold path pays on EVERY
   request. Everything above this line is stdlib-only and the heavy imports live inside
   the cold path -- importing torch here would give back several seconds of the very
   cost this path exists to avoid.

2. COLD (fallback). Exactly the previous behaviour: load the model in-process and run.
   Used when no warm URL is configured, the service is down, or it is running a
   different configuration than the caller asked for. The fallback is deliberate: the
   website must keep working if the warm service dies, just more slowly.

Why this wrapper exists at all instead of the plain CLI: the CLI has no flag for
GPU-accelerated export resampling. Swapping ConfigurationManager.resampling_fn_probabilities
for resample_torch_fornnunet cuts that stage from ~26-42s to ~1-6s with no accuracy cost
(lesion Dice 0.998-1.0 vs the CPU-resample output). The CLI's export step has no hook to
apply this from outside, and patching the vendored nnU-Net install would hit every other
model in this deployment.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

# Recall-oriented operating point for pancreatic_lesion (channel/label 40 in this
# model's 43-class space). After argmax, any voxel whose lesion-channel probability
# clears LESION_THRESHOLD is set to the lesion label, even if argmax picked normal
# tissue. Validated on 474 GT cases: T~0.05 lifts Dice 0.383->0.404 and detection
# 69%->83% at ZERO extra runtime (same forward pass, different cutoff). It trades
# some precision for recall, which suits a triage/first-read tool. Set
# LESIONSEG_LESION_THRESHOLD=0 to disable (pure argmax).
_LESION_CHANNEL = int(os.environ.get("LESIONSEG_LESION_CHANNEL", "40"))
_LESION_THRESHOLD = float(os.environ.get("LESIONSEG_LESION_THRESHOLD", "0.05"))


def _warm_predict(input_dir, output_dir, step_size, disable_tta, url, timeout):
    """Try the persistent predictor. Returns True if it produced the output.

    Any failure returns False so the caller falls back to cold inference -- a warm
    service that is down, busy, or differently configured must degrade to a slow
    correct answer, never to a wrong or missing one.
    """
    base = url.rstrip("/")
    try:
        with urllib.request.urlopen(f"{base}/health", timeout=5) as r:
            health = json.loads(r.read())
    except Exception as e:
        print(f"[warm] health check failed ({e}); using cold path", flush=True)
        return False

    # The server also enforces this and answers 409, but checking here keeps the
    # reason in this process's log where the failure is being handled.
    if abs(float(health.get("step_size", -1)) - float(step_size)) > 1e-9 \
            or bool(health.get("disable_tta")) != bool(disable_tta):
        print(f"[warm] config mismatch (server step={health.get('step_size')} "
              f"disable_tta={health.get('disable_tta')}; requested step={step_size} "
              f"disable_tta={disable_tta}); using cold path", flush=True)
        return False

    # The service only accepts locations as relative paths under the root it was
    # started with, and builds the absolute path itself. If our directories are not
    # under that root it cannot serve them -- fall back rather than trying to coax it.
    root = health.get("allowed_root")
    if not root:
        print("[warm] server did not report allowed_root; using cold path", flush=True)
        return False
    try:
        rel_in = os.path.relpath(os.path.realpath(input_dir), root)
        rel_out = os.path.relpath(os.path.realpath(output_dir), root)
    except ValueError as e:      # e.g. different drives on Windows
        print(f"[warm] cannot relativise paths against {root} ({e}); using cold path", flush=True)
        return False
    if any(r == os.pardir or r.startswith(os.pardir + os.sep) or os.path.isabs(r)
           for r in (rel_in, rel_out)):
        print(f"[warm] paths are outside the server root {root}; using cold path", flush=True)
        return False

    body = json.dumps({
        "input_rel": rel_in.replace(os.sep, "/"),
        "output_rel": rel_out.replace(os.sep, "/"),
        "step_size": float(step_size),
        "disable_tta": bool(disable_tta),
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
        print(f"done with {item.get('case_id')} ({item.get('seconds')}s, warm)", flush=True)
    if not resp.get("results"):
        print("[warm] server returned no results; using cold path", flush=True)
        return False
    print(f"[warm] total {resp.get('total_seconds')}s", flush=True)
    return True


def _cold_predict(args):
    """In-process inference. Heavy imports are local so the warm path never pays them."""
    from functools import partial

    import torch
    from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor
    from nnunetv2.imageio.simpleitk_reader_writer import SimpleITKIO
    from nnunetv2.preprocessing.preprocessors.default_preprocessor import DefaultPreprocessor
    from nnunetv2.inference.export_prediction import (
        convert_predicted_logits_to_segmentation_with_correct_shape as convert_logits,
    )
    import nnunetv2.utilities.plans_handling.plans_handler as plans_handler
    from nnunetv2.preprocessing.resampling.resample_torch import resample_torch_fornnunet

    if not torch.cuda.is_available():
        print("ERROR: CUDA not available", file=sys.stderr)
        sys.exit(1)

    def _patch_gpu_export_resample():
        def _resampling_fn_probabilities(self):
            return partial(resample_torch_fornnunet, device=torch.device("cuda"), is_seg=False)
        plans_handler.ConfigurationManager.resampling_fn_probabilities = property(
            _resampling_fn_probabilities
        )

    _patch_gpu_export_resample()

    predictor = nnUNetPredictor(
        tile_step_size=args.step_size,
        use_mirroring=not args.disable_tta,
        perform_everything_on_device=True,
        device=torch.device("cuda"),
        allow_tqdm=False,
        verbose=False,
    )
    predictor.initialize_from_trained_model_folder(
        args.model_dir, use_folds=("all",), checkpoint_name=args.checkpoint_name
    )

    reader_writer = SimpleITKIO()
    preprocessor = DefaultPreprocessor(verbose=False)

    def _export_gpu_resident(logits, props):
        """Turn logits into the final segmentation without the CPU round trip.

        predict_logits_from_preprocessed_data returns logits on the CPU, so the default
        convert_logits path moves the ~1.5 GB, 43-channel volume CPU->GPU to run the
        (already GPU-patched) export resample, then back again. Keeping it resident on the
        GPU -- same resample function, same spacings, same argmax -- removes that transfer
        and the CPU-side handling. Measured bit-identical to convert_logits (0 differing
        voxels across a size-stratified sample, including anisotropic cases) at ~3.6-25x on
        the export stage.

        Only valid for a plain softmax-argmax label space; region-based models need the
        label manager's own logic, so those fall back to convert_logits.
        """
        pm, cm = predictor.plans_manager, predictor.configuration_manager
        lg = (logits if torch.is_tensor(logits) else torch.from_numpy(logits)).to("cuda")
        # spacings, exactly as convert_logits computes them
        spacing_t = [props["spacing"][i] for i in pm.transpose_forward]
        target = props["shape_after_cropping_and_before_resampling"]
        current_spacing = cm.spacing if len(cm.spacing) == len(target) else [spacing_t[0], *cm.spacing]
        new_spacing = [props["spacing"][i] for i in pm.transpose_forward]
        resampled = cm.resampling_fn_probabilities(lg, target, current_spacing, new_spacing)
        if not torch.is_tensor(resampled):
            resampled = torch.as_tensor(resampled, device="cuda")
        # non-region model: convert_logits_to_segmentation is argmax over channels, and
        # argmax(logits) == argmax(softmax(logits)) since softmax is monotonic
        seg = resampled.argmax(0).to(torch.uint8)
        # Recall operating point: override to the lesion label where the lesion
        # channel's probability clears the threshold (see module docstring on
        # _LESION_THRESHOLD). Same resampled logits, so no extra forward pass.
        if _LESION_THRESHOLD > 0.0 and resampled.shape[0] > _LESION_CHANNEL:
            lesion_prob = torch.softmax(resampled, 0)[_LESION_CHANNEL]
            seg[lesion_prob > _LESION_THRESHOLD] = _LESION_CHANNEL
            del lesion_prob
        out = torch.zeros(tuple(props["shape_before_cropping"]), dtype=torch.uint8, device=seg.device)
        out[tuple(slice(b[0], b[1]) for b in props["bbox_used_for_cropping"])] = seg
        out_np = out.cpu().numpy().transpose(pm.transpose_backward)
        del lg, resampled, seg, out
        torch.cuda.empty_cache()
        return out_np

    use_gpu_export = not getattr(predictor.label_manager, "has_regions", False)

    case_files = sorted(
        f for f in os.listdir(args.input_dir)
        if f.endswith("_0000.nii.gz") or f.endswith("_0000.nii")
    )
    if not case_files:
        print(f"No cases found in {args.input_dir}", file=sys.stderr)
        sys.exit(1)

    for fname in case_files:
        case_id = fname[:-len("_0000.nii.gz")] if fname.endswith(".gz") else fname[:-len("_0000.nii")]
        print(f"Predicting {case_id}:", flush=True)

        data, properties = reader_writer.read_images([os.path.join(args.input_dir, fname)])
        preprocessed, _, preprocessed_props = preprocessor.run_case_npy(
            data, None, properties,
            predictor.plans_manager, predictor.configuration_manager, predictor.dataset_json,
        )
        logits = predictor.predict_logits_from_preprocessed_data(torch.from_numpy(preprocessed))
        if use_gpu_export:
            segmentation = _export_gpu_resident(logits, preprocessed_props)
        else:
            segmentation = convert_logits(
                logits, predictor.plans_manager, predictor.configuration_manager,
                predictor.label_manager, preprocessed_props, False,
            )
        reader_writer.write_seg(
            segmentation, os.path.join(args.output_dir, f"{case_id}.nii.gz"), preprocessed_props
        )
        print(f"done with {case_id}", flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("-i", dest="input_dir", required=True, help="Folder of {case}_0000.nii[.gz] files")
    ap.add_argument("-o", dest="output_dir", required=True)
    ap.add_argument("-m", dest="model_dir", required=True, help="nnU-Net model folder (dataset.json/plans.json/fold_*)")
    ap.add_argument("-step_size", type=float, default=0.9)
    ap.add_argument("--disable_tta", action="store_true")
    ap.add_argument("-chk", dest="checkpoint_name", default="checkpoint_final.pth")
    args = ap.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    warm_url = os.getenv("LESIONSEG_WARM_URL", "").strip()
    if warm_url:
        timeout = int(os.getenv("LESIONSEG_WARM_TIMEOUT", "3600"))
        if _warm_predict(args.input_dir, args.output_dir, args.step_size,
                         args.disable_tta, warm_url, timeout):
            return

    _cold_predict(args)


if __name__ == "__main__":
    main()
