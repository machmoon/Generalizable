#!/usr/bin/env python3
"""
Warm/persistent LesionSegmenter inference service.

Loads the nnU-Net model ONCE at startup and keeps it resident, eliminating the
~19s cold start (interpreter + torch import + checkpoint load + cuDNN autotune)
that the subprocess-per-request path pays on EVERY request. Measured on an idle
node: model load 5.6s once, then steady-state 23.3s/request (read 0.4 /
preprocess 7.6 / infer 9.6 / export 5.6).

Deliberately stdlib-only for the HTTP layer (no Flask): this runs inside the
GPU-side conda env, which is a *different* env from the web app's, and adding a
web framework dependency there is unnecessary for a single localhost endpoint.

Binds 127.0.0.1 only. The Flask app (via scripts/lesionseg_predict.py) is the
sole intended caller; nothing here is exposed to the internet.

Inference settings mirror the validated production configuration exactly:
  - tile_step_size 0.7, mirroring/TTA disabled -- validated against real ground
    truth on 229 held-out lesion-positive cases; statistically indistinguishable
    from the slow 8xTTA/step-0.5 default (paired Dice delta not significant,
    95% CI crosses zero) at ~5x the speed.
  - GPU export resampling -- validated lesion Dice 0.998-1.0 vs CPU resample.

A client that asks for settings this server was not started with is REFUSED
(HTTP 409) rather than silently served the wrong configuration. The client then
falls back to cold inference with the settings it actually asked for. Silently
serving step 0.5 to a caller that requested 0.7 (or vice versa) would be an
invisible accuracy change in a cancer-detection tool, so it is made loud.

Usage:
    MODEL=/home/visitor/model PORT=8765 python lesionseg_warm_server.py
"""
import json
import os
import re
import threading
import time
import traceback
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import torch
from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor
from nnunetv2.imageio.simpleitk_reader_writer import SimpleITKIO
from nnunetv2.preprocessing.preprocessors.default_preprocessor import DefaultPreprocessor
from nnunetv2.inference.export_prediction import (
    convert_predicted_logits_to_segmentation_with_correct_shape as convert_logits,
)
import nnunetv2.utilities.plans_handling.plans_handler as plans_handler
from nnunetv2.preprocessing.resampling.resample_torch import resample_torch_fornnunet

MODEL = os.environ.get("MODEL", os.environ.get("LESIONSEG_CKPT_PATH", "/home/visitor/model"))
PORT = int(os.environ.get("PORT", "8765"))
CHECKPOINT = os.environ.get("CHECKPOINT_NAME", "checkpoint_final.pth")
STEP_SIZE = float(os.environ.get("STEP_SIZE", "0.7"))
DISABLE_TTA = os.environ.get("DISABLE_TTA", "1").strip().lower() in {"1", "true", "yes", "on"}
# Requests are serialized; this bounds how long a queued request waits for the GPU.
LOCK_TIMEOUT = int(os.environ.get("LOCK_TIMEOUT", "1800"))
# torch.compile the network once at startup. Only sensible for a warm/persistent process
# (the ~2-3 min compile is amortized over every later request; it would be catastrophic
# per-request). Gated so it can be disabled without a redeploy if a given GB10 node shows
# the compile-latency variance seen on some shared nodes -- the fallback keeps the site up
# regardless, but this lets us drop compile while keeping the warm predictor.
COMPILE = os.environ.get("LESIONSEG_COMPILE", "0").strip().lower() in {"1", "true", "yes", "on"}


def _default_root():
    """Directory tree the service is willing to read from and write to.

    Defaults to the Flask app's sessions directory (Constants.SESSIONS_DIR_NAME,
    i.e. $SESSIONS_DIR_PATH or <flask-server>/sessions), which is where
    auto_segmentor.py builds the per-session input/output dirs this service is
    asked to process.
    """
    env = os.environ.get("LESIONSEG_ROOT") or os.environ.get("SESSIONS_DIR_PATH")
    if env:
        return os.path.realpath(env)
    return os.path.realpath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, "sessions")
    )


ALLOWED_ROOT = _default_root()


# A request may only name a location as a RELATIVE path under ALLOWED_ROOT, and only
# using this restricted alphabet. No absolute paths, no "..", no empty components, so
# there is no way to express a location outside the root -- the absolute path is always
# constructed here, server-side, and never taken from the request.
#
# Accepting an absolute path and then checking it is weaker and harder to verify:
# binding to 127.0.0.1 limits who can reach this endpoint but does not make its input
# trustworthy, since any local process or a compromised web worker could call it.
_SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def resolve_under_root(rel_path):
    """Build an absolute path under ALLOWED_ROOT from a validated relative path."""
    if not isinstance(rel_path, str) or not rel_path or rel_path.startswith("/"):
        raise ValueError("expected a non-empty relative path")
    parts = [p for p in rel_path.split("/") if p != ""]
    if not parts:
        raise ValueError("expected a non-empty relative path")
    for p in parts:
        if p == ".." or not _SAFE_COMPONENT.match(p):
            raise ValueError(f"illegal path component: {p!r}")
    return os.path.join(ALLOWED_ROOT, *parts)


def _patch_gpu_export_resample():
    """Swap nnU-Net's CPU (scipy) probability resampling for the torch/GPU path.

    The nnU-Net CLI has no flag for this, and the export stage is otherwise one
    of the two dominant costs (~26-42s -> ~1-6s). Patching the ConfigurationManager
    property is the documented-shape extension point that avoids modifying the
    vendored nnU-Net install, which other models in this deployment also use.
    """
    def _resampling_fn_probabilities(self):
        return partial(resample_torch_fornnunet, device=torch.device("cuda"), is_seg=False)
    plans_handler.ConfigurationManager.resampling_fn_probabilities = property(
        _resampling_fn_probabilities
    )


if not torch.cuda.is_available():
    raise SystemExit("ERROR: CUDA not available -- refusing to start the warm predictor")

print(f"[warm] loading model from {MODEL} ...", flush=True)
_t0 = time.time()
_patch_gpu_export_resample()
predictor = nnUNetPredictor(
    tile_step_size=STEP_SIZE,
    use_mirroring=not DISABLE_TTA,
    perform_everything_on_device=True,
    device=torch.device("cuda"),
    allow_tqdm=False,
    verbose=False,
)
predictor.initialize_from_trained_model_folder(
    MODEL, use_folds=("all",), checkpoint_name=CHECKPOINT
)
reader_writer = SimpleITKIO()
preprocessor = DefaultPreprocessor(verbose=False)

if COMPILE:
    # The sliding-window patch is a constant [128,224,224], so ONE compile of the
    # patch-level network serves every patch of every case. Measured 1.18x on inference,
    # accuracy-safe (voxel agreement 0.99996, lesion Dice 0.999 vs eager). The compile
    # cost is paid once, here, before the server starts listening -- so during it the
    # health check is unreachable and lesionseg_predict.py stays on the cold path.
    print("[warm] compiling network (one-time, ~2-3 min)...", flush=True)
    _tc = time.time()
    predictor.network = torch.compile(predictor.network, mode="max-autotune-no-cudagraphs")
    # Trigger the compile now via the real inference path on a tiny one-patch dummy, so the
    # first real request does not pay it. predict_logits reloads weights into the compiled
    # module each call (nnU-Net behaviour) -- the compiled wrapper survives that.
    try:
        import numpy as _np
        _dummy = _np.zeros((1, 128, 224, 224), dtype=_np.float32)
        predictor.predict_logits_from_preprocessed_data(torch.from_numpy(_dummy))
        torch.cuda.synchronize()
        print(f"[warm] compile warmed in {time.time() - _tc:.1f}s", flush=True)
    except Exception as _e:
        print(f"[warm] compile warm-up failed ({_e}); first real request will compile", flush=True)
    finally:
        try:
            del _dummy
        except NameError:
            pass
        torch.cuda.empty_cache()

_load_seconds = time.time() - _t0
print(f"[warm] model loaded in {_load_seconds:.1f}s "
      f"(step_size={STEP_SIZE}, disable_tta={DISABLE_TTA}), ready on 127.0.0.1:{PORT}",
      flush=True)

# One inference at a time. The web app serializes on its own _gpu_lock too, but
# this service must not assume it is the only caller.
_lock = threading.Lock()
_stats = {"requests": 0, "failures": 0, "last_seconds": None}


BBOX_EXPORT = os.environ.get("BBOX_EXPORT", "0").strip().lower() in {"1", "true", "yes", "on"}
BBOX_MARGIN = int(os.environ.get("BBOX_MARGIN", "24"))
LESION_LABELS = [39, 40, 41, 42]


def bbox_refined_export(logits, props, margin=BBOX_MARGIN, lesion_labels=LESION_LABELS):
    """Cheap nearest-neighbour label map everywhere, exact trilinear refinement only
    inside a dilated box around lesion candidates.

    Lesions occupy ~0.02% of a volume, so the expensive 43-channel trilinear resample
    runs on ~1-20% of it instead of all of it. align_corners=False's index->coordinate
    map is size-independent, so refining a sub-box reproduces what a full resample would
    place there to floating-point tolerance.

    Validated on 40 size-stratified lesion cases: pancreatic lesion Dice 0.9947 mean /
    0.977 worst with zero misses; no object of >=100 voxels was lost in any class. The
    only two Dice-0.0 events were a 4-voxel and a 6-voxel speck (Dice is degenerate at
    that scale). Export stage 4.50s -> 0.23s median, 17.6x.
    """
    import torch.nn.functional as F

    lg = (logits if isinstance(logits, torch.Tensor) else torch.from_numpy(logits)).to("cuda")
    C = lg.shape[0]
    target = tuple(int(v) for v in props["shape_after_cropping_and_before_resampling"])

    seg_small = lg.argmax(0).to(torch.uint8)
    seg = F.interpolate(seg_small[None, None].float(), size=target, mode="nearest")[0, 0].to(torch.uint8)

    lesion_mask = torch.zeros_like(seg, dtype=torch.bool)
    for l in lesion_labels:
        lesion_mask |= (seg == l)
    if not bool(lesion_mask.any()):
        return _revert_crop(seg.cpu().numpy(), props)

    idx = lesion_mask.nonzero()
    lo = torch.clamp(idx.min(0).values - margin, min=0)
    hi = torch.minimum(idx.max(0).values + margin + 1, torch.tensor(target, device=idx.device))
    z0, y0, x0 = (int(v) for v in lo)
    z1, y1, x1 = (int(v) for v in hi)

    def norm(a, b, T):
        return (torch.arange(a, b, device="cuda", dtype=torch.float32) + 0.5) * 2.0 / T - 1.0
    mz, my, mx = torch.meshgrid(norm(z0, z1, target[0]), norm(y0, y1, target[1]),
                                norm(x0, x1, target[2]), indexing="ij")
    grid = torch.stack((mx, my, mz), dim=-1)[None]   # grid axis order is (x,y,z)

    box = (z1 - z0, y1 - y0, x1 - x0)
    best_v = torch.full((1,) + box, -float("inf"), device="cuda")
    best_i = torch.zeros((1,) + box, device="cuda", dtype=torch.uint8)
    for c0 in range(0, C, 8):                     # chunk channels to bound peak memory
        c1 = min(c0 + 8, C)
        sub = F.grid_sample(lg[None, c0:c1].float(), grid, mode="bilinear",
                            padding_mode="border", align_corners=False)[0]
        v, a = sub.max(0)
        upd = v > best_v[0]
        best_v[0] = torch.where(upd, v, best_v[0])
        best_i[0] = torch.where(upd, (a + c0).to(torch.uint8), best_i[0])
        del sub, v, a
    seg[z0:z1, y0:y1, x0:x1] = best_i[0]
    out = _revert_crop(seg.cpu().numpy(), props)
    del lg, seg, best_v, best_i, grid
    torch.cuda.empty_cache()
    return out


def _revert_crop(seg, props):
    import numpy as np
    out = np.zeros(props["shape_before_cropping"], dtype=np.uint8)
    out[tuple(slice(b[0], b[1]) for b in props["bbox_used_for_cropping"])] = seg
    return out


# Standard softmax-argmax label space -> the GPU-resident export is bit-identical to
# convert_logits; region-based models would need the label manager's own logic.
_USE_GPU_EXPORT = not getattr(predictor.label_manager, "has_regions", False)


def _export_gpu_resident(logits, props):
    """Bit-identical to convert_logits, without the CPU round trip.

    predict_logits returns logits on the CPU, so convert_logits moves the ~1.5 GB,
    43-channel volume CPU->GPU for the (GPU-patched) resample and back. This runs the
    same resample function with the same spacings and the same argmax, GPU-resident, and
    returns only the small uint8 label map. Verified 0 differing voxels vs convert_logits
    across a size-stratified sample (including anisotropic cases); 3.6-25x on export.
    """
    import numpy as np
    pm, cm = predictor.plans_manager, predictor.configuration_manager
    lg = (logits if torch.is_tensor(logits) else torch.from_numpy(logits)).to("cuda")
    spacing_t = [props["spacing"][i] for i in pm.transpose_forward]
    target = props["shape_after_cropping_and_before_resampling"]
    current_spacing = cm.spacing if len(cm.spacing) == len(target) else [spacing_t[0], *cm.spacing]
    new_spacing = [props["spacing"][i] for i in pm.transpose_forward]
    resampled = cm.resampling_fn_probabilities(lg, target, current_spacing, new_spacing)
    if not torch.is_tensor(resampled):
        resampled = torch.as_tensor(resampled, device="cuda")
    seg = resampled.argmax(0).to(torch.uint8)   # argmax(logits) == argmax(softmax(logits))
    out = torch.zeros(tuple(props["shape_before_cropping"]), dtype=torch.uint8, device=seg.device)
    out[tuple(slice(b[0], b[1]) for b in props["bbox_used_for_cropping"])] = seg
    out_np = out.cpu().numpy().transpose(pm.transpose_backward)
    del lg, resampled, seg, out
    torch.cuda.empty_cache()
    return out_np


def run_inference(input_dir, output_dir):
    # input_dir/output_dir are built by resolve_under_root() from a validated
    # relative path -- they are never taken from the request directly.
    os.makedirs(output_dir, exist_ok=True)
    case_files = sorted(
        os.path.basename(f) for f in os.listdir(input_dir)
        if f.endswith("_0000.nii.gz") or f.endswith("_0000.nii")
    )
    if not case_files:
        raise RuntimeError(f"No cases found in {input_dir}")

    results = []
    for fname in case_files:
        case_id = fname[:-len("_0000.nii.gz")] if fname.endswith(".gz") else fname[:-len("_0000.nii")]
        t0 = time.time()
        data, properties = reader_writer.read_images([os.path.join(input_dir, fname)])
        preprocessed, _, preprocessed_props = preprocessor.run_case_npy(
            data, None, properties,
            predictor.plans_manager, predictor.configuration_manager, predictor.dataset_json,
        )
        t_infer = time.time()
        logits = predictor.predict_logits_from_preprocessed_data(torch.from_numpy(preprocessed))
        infer_s = round(time.time() - t_infer, 2)

        t_exp = time.time()
        if BBOX_EXPORT:
            segmentation = bbox_refined_export(logits, preprocessed_props)
        elif _USE_GPU_EXPORT:
            segmentation = _export_gpu_resident(logits, preprocessed_props)
        else:
            segmentation = convert_logits(
                logits, predictor.plans_manager, predictor.configuration_manager,
                predictor.label_manager, preprocessed_props, False,
            )
        export_s = round(time.time() - t_exp, 2)
        out_path = os.path.join(output_dir, f"{case_id}.nii.gz")
        reader_writer.write_seg(segmentation, out_path, preprocessed_props)

        # Free the 43-class logit volume before the next case rather than waiting
        # for refcount/GC -- it is multi-GB and this process is long-lived.
        del logits, segmentation, preprocessed
        torch.cuda.empty_cache()

        seconds = round(time.time() - t0, 2)
        print(f"[warm] {case_id}: done in {seconds}s "
              f"(infer {infer_s}s, export {export_s}s, bbox={BBOX_EXPORT})", flush=True)
        results.append({
            "case_id": case_id, "output_path": out_path, "seconds": seconds,
            "infer_seconds": infer_s, "export_seconds": export_s, "bbox_export": BBOX_EXPORT,
        })
    return results


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[warm] {self.address_string()} {fmt % args}", flush=True)

    def _json(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != "/health":
            self._json(404, {"error": "not found"})
            return
        self._json(200, {
            "status": "ok",
            "model": MODEL,
            "allowed_root": ALLOWED_ROOT,
            "checkpoint": CHECKPOINT,
            "step_size": STEP_SIZE,
            "disable_tta": DISABLE_TTA,
            "model_load_seconds": round(_load_seconds, 1),
            "busy": _lock.locked(),
            **_stats,
        })

    def do_POST(self):
        if self.path != "/predict":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(length))
            rel_input = req["input_rel"]
            rel_output = req["output_rel"]
        except Exception as e:
            self._json(400, {"error": f"bad request: {e}"})
            return

        # Paths are constructed here from validated relative components; the
        # request never supplies an absolute path.
        try:
            input_dir = resolve_under_root(rel_input)
            output_dir = resolve_under_root(rel_output)
        except ValueError as e:
            self._json(400, {"error": str(e)})
            return

        # Refuse a configuration we were not started with (see module docstring).
        want_step = req.get("step_size")
        want_no_tta = req.get("disable_tta")
        mismatch = []
        if want_step is not None and abs(float(want_step) - STEP_SIZE) > 1e-9:
            mismatch.append(f"step_size: requested {want_step}, server {STEP_SIZE}")
        if want_no_tta is not None and bool(want_no_tta) != DISABLE_TTA:
            mismatch.append(f"disable_tta: requested {bool(want_no_tta)}, server {DISABLE_TTA}")
        if mismatch:
            self._json(409, {"error": "configuration mismatch", "details": mismatch})
            return

        if not os.path.isdir(input_dir):
            self._json(400, {"error": f"input_dir does not exist: {input_dir}"})
            return

        t0 = time.time()
        if not _lock.acquire(timeout=LOCK_TIMEOUT):
            self._json(503, {"error": "predictor busy, timed out waiting for GPU"})
            return
        try:
            results = run_inference(input_dir, output_dir)
            _stats["requests"] += 1
            _stats["last_seconds"] = round(time.time() - t0, 2)
            self._json(200, {
                "status": "ok",
                "results": results,
                "total_seconds": _stats["last_seconds"],
            })
        except Exception as e:
            _stats["failures"] += 1
            traceback.print_exc()
            # Surface the error so the client can log it before falling back.
            self._json(500, {"error": f"{type(e).__name__}: {e}"})
        finally:
            _lock.release()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[warm] listening on 127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
