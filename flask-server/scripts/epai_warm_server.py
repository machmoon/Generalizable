#!/usr/bin/env python3
"""
Warm/persistent ePAI (qchen76 fork) inference service.

Same pattern as scripts/lesionseg_warm_server.py -- loads the model ONCE and keeps
it resident, eliminating the cold-start subprocess reload (interpreter + torch
import + checkpoint load + cuDNN autotune) that services/auto_segmentor.py's
EPAI_SCRIPT_PATH hook currently pays on EVERY request via epai_predict.py.

Deliberately stdlib-only for the HTTP layer, binds 127.0.0.1 only -- see
lesionseg_warm_server.py's docstring for the full rationale, unchanged here.

Inference settings mirror the validated configuration:
  - EPAI_TTA_AXES -- which mirroring axes to average over test-time. Real-GT
    frontier data (n=475 step/TTA sweep + n=332 independent axis sweep, both
    against real pancreatic_lesion ground truth, not fidelity) shows full
    no-TTA (EPAI_DISABLE_TTA) carries a small but real accuracy cost (mean
    delta dice -0.014, 95% CI excludes 0; more whole-lesion misses than full
    TTA). In-plane-only mirroring ("1,2") gets nearly the same speedup
    (1.48x vs no-TTA's ~2.2x) with NO measurable cost (95% CI includes 0,
    zero whole-lesion misses vs full 8x TTA) -- the better trade. Set both
    this and EPAI_DISABLE_TTA=false to run it; leave both unset for the old
    full-8x-TTA behavior.
  - GPU export-resident resampling -- validated at 500-case scale, ~51-55x on
    the export stage, voxel agreement 0.99996+ (see epai_export_bench.py).
  - tile_step_size is NOT overridden from the nnU-Net default (0.5) here --
    unlike LesionSegmenter's banked 0.7, ePAI's own step size was never swept
    against real ground truth. Do not change EPAI_STEP_SIZE's default without
    that validation first (same rigor as the TTA frontier: real GT, report
    detection rate and whole-lesion misses, not just mean dice).
  - EPAI_TRT_PLAN_PATH -- TensorRT FP16 inference, validated n=1033
    (epai_trt_scaleup.py), 0 errors, mean speedup 1.66x, argmax agreement vs
    eager 99.99%+ (min 0.9997). Off by default (opt-in via the env var) so a
    first prod rollout can be watched before it's the default for everyone --
    same rollout discipline as the warm predictor itself. Set to the built
    .plan (see epai_trt_fp16.py) to enable.

A client requesting settings this server was not started with is REFUSED
(HTTP 409), matching lesionseg_warm_server.py's reasoning: silently serving a
different configuration would be an invisible accuracy change in a
cancer-detection tool.

Two fork-specific fixes vs the standard-nnU-Net LesionSegmenter wrapper (see
epai_predict.py's docstring for the full story of how each was found):
  1. determine_do_sep_z_and_axis in the fork returns the anisotropy axis as a
     bare scalar on the separate-z path; resample_torch's `assert len(axis)==1`
     needs a 1-element list. Coerce scalar -> [int(axis)].
  2. This model's plans specify NibabelIOWithReorient, not SimpleITKIO --
     reading with the wrong reader class produces a properties dict missing
     'nibabel_stuff', which the nibabel writer needs -> KeyError in write_seg.
  3. export_prediction_from_logits's write path (segmentation file, tumor-stats
     extraction, output-CSV update) is entirely gated behind
     `if save_probabilities:` in this fork -- despite the name, this does NOT
     mean "write a probabilities.npz" (that branch is commented out). It MUST
     be True or nothing is written at all, silently, rc=0.

Usage:
    EPAI_CKPT_PATH=/home/visitor/ePAI/model/... PORT=8766 python epai_warm_server.py
"""
import json
import os
import re
import threading
import time
import traceback
from functools import partial
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import torch
from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor
from nnunetv2.preprocessing.preprocessors.default_preprocessor import DefaultPreprocessor
from nnunetv2.inference.export_prediction import export_prediction_from_logits
from nnunetv2.preprocessing.resampling.resample_torch import resample_torch_fornnunet
import nnunetv2.preprocessing.resampling.resample_torch as _rt
import nnunetv2.utilities.plans_handling.plans_handler as _ph

MODEL = os.environ.get(
    "EPAI_CKPT_PATH",
    "/home/visitor/ePAI/model/qchen76_2025_0421/nnUNetTrainer__nnUNetPlans__3d_fullres",
)
PORT = int(os.environ.get("PORT", "8766"))
CHECKPOINT = os.environ.get("EPAI_CHECKPOINT_NAME", "checkpoint_final.pth")
STEP_SIZE = float(os.environ.get("EPAI_STEP_SIZE", "0.5"))
DISABLE_TTA = os.environ.get("EPAI_DISABLE_TTA", "0").strip().lower() in {"1", "true", "yes", "on"}
LOCK_TIMEOUT = int(os.environ.get("LOCK_TIMEOUT", "1800"))


def _parse_axes(raw):
    """"1,2" -> (1, 2); "" / unset -> None (nnU-Net's own default: all 3 axes)."""
    raw = (raw or "").strip()
    if not raw:
        return None
    return tuple(int(x) for x in raw.split(","))


TTA_AXES = _parse_axes(os.environ.get("EPAI_TTA_AXES"))
TRT_PLAN_PATH = os.environ.get("EPAI_TRT_PLAN_PATH", "").strip()


def _default_root():
    """Directory tree the service is willing to read from and write to.

    Mirrors lesionseg_warm_server.py's _default_root(): the Flask app's
    sessions directory, where auto_segmentor.py builds the per-session
    input/output dirs this service is asked to process.
    """
    env = os.environ.get("EPAI_WARM_ROOT") or os.environ.get("SESSIONS_DIR_PATH")
    if env:
        return os.path.realpath(env)
    return os.path.realpath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), os.pardir, "sessions")
    )


ALLOWED_ROOT = _default_root()

# Same containment pattern as lesionseg_warm_server.py (CodeQL-verified there):
# a request may only name a location as a validated RELATIVE path under
# ALLOWED_ROOT. No absolute paths, no "..". The absolute path is always built
# server-side; the request's path components are never trusted directly.
_SAFE_COMPONENT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def resolve_under_root(rel_path):
    if not isinstance(rel_path, str) or not rel_path or rel_path.startswith("/"):
        raise ValueError("expected a non-empty relative path")
    parts = [p for p in rel_path.split("/") if p != ""]
    if not parts:
        raise ValueError("expected a non-empty relative path")
    for p in parts:
        if p == ".." or not _SAFE_COMPONENT.match(p):
            raise ValueError(f"illegal path component: {p!r}")
    return os.path.join(ALLOWED_ROOT, *parts)


def _apply_fork_fixes():
    _orig_determine = _rt.determine_do_sep_z_and_axis

    def _fixed_determine(*a, **k):
        do_sep, axis = _orig_determine(*a, **k)
        if do_sep and np.isscalar(axis):
            axis = [int(axis)]
        return do_sep, axis

    _rt.determine_do_sep_z_and_axis = _fixed_determine

    _ph.ConfigurationManager.resampling_fn_probabilities = property(
        lambda self: partial(resample_torch_fornnunet, device=torch.device("cuda"), is_seg=False)
    )


class TrtRunner:
    """Loads the FP16 engine once; forward() matches the eager net's signature
    so it can replace predictor.network.forward directly. Output buffer
    allocated ONCE (the fix for the INT8-era per-patch-allocation stall) and
    the engine runs on torch's current stream (no per-call host sync) -- see
    epai_trt_fp16.py, where this exact class was validated.
    """

    def __init__(self, plan_path):
        import tensorrt as trt

        logger = trt.Logger(trt.Logger.WARNING)
        runtime = trt.Runtime(logger)
        with open(plan_path, "rb") as f:
            self.engine = runtime.deserialize_cuda_engine(f.read())
        self.context = self.engine.create_execution_context()
        self.in_name = self.engine.get_tensor_name(0)
        self.out_name = self.engine.get_tensor_name(1)
        out_shape = tuple(self.context.get_tensor_shape(self.out_name))
        self.out_buf = torch.empty(out_shape, dtype=torch.float16, device="cuda")
        self.context.set_tensor_address(self.out_name, self.out_buf.data_ptr())

    def forward(self, x):
        x = x.half().contiguous()
        self.context.set_input_shape(self.in_name, tuple(x.shape))
        self.context.set_tensor_address(self.in_name, x.data_ptr())
        s = torch.cuda.current_stream()
        self.context.execute_async_v3(s.cuda_stream)
        return self.out_buf.float()


def _maybe_load_trt(net):
    """Returns True if TRT is now serving net.forward, False on any problem
    (missing plan, missing tensorrt package, bad engine) -- inference must
    degrade to correct-but-slower eager, never fail to start over this."""
    if not TRT_PLAN_PATH:
        return False
    if not os.path.isfile(TRT_PLAN_PATH):
        print(f"[warm] EPAI_TRT_PLAN_PATH set but not found: {TRT_PLAN_PATH}; using eager", flush=True)
        return False
    try:
        runner = TrtRunner(TRT_PLAN_PATH)
        net.forward = lambda x: runner.forward(x)
        return True
    except Exception as e:
        print(f"[warm] TRT engine load failed ({type(e).__name__}: {e}); using eager", flush=True)
        return False


if not torch.cuda.is_available():
    raise SystemExit("ERROR: CUDA not available -- refusing to start the warm predictor")

print(f"[warm] loading model from {MODEL} ...", flush=True)
_t0 = time.time()
_apply_fork_fixes()
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
if TTA_AXES is not None and not DISABLE_TTA:
    predictor.allowed_mirroring_axes = TTA_AXES
preprocessor = DefaultPreprocessor(verbose=False)
# Must match the writer export_prediction_from_logits uses internally (see
# module docstring, fix 2) -- this model's plans specify NibabelIOWithReorient.
reader_writer = predictor.plans_manager.image_reader_writer_class()
TRT_ACTIVE = _maybe_load_trt(predictor.network)

_load_seconds = time.time() - _t0
print(f"[warm] model loaded in {_load_seconds:.1f}s "
      f"(step_size={STEP_SIZE}, disable_tta={DISABLE_TTA}, tta_axes={TTA_AXES}, trt={TRT_ACTIVE}), "
      f"ready on 127.0.0.1:{PORT}",
      flush=True)

_lock = threading.Lock()
_stats = {"requests": 0, "failures": 0, "last_seconds": None}


def _discover_case(input_dir):
    """Derive case_id from a file actually present in the validated input_dir,
    the same pattern lesionseg_warm_server.py uses (CodeQL-verified there): the
    client's case_id string must never reach a path operation, even after
    input_dir itself is validated -- a containment check on input_dir alone
    does not make case_id safe to interpolate into a filename (CodeQL flagged
    exactly this: os.path.join(dir, f"{case_id}...") lets an absolute-path
    case_id discard dir entirely). Removing the tainted flow, not auditing it.
    """
    candidates = [f for f in os.listdir(input_dir) if f.endswith("_0000.nii.gz")]
    if len(candidates) != 1:
        raise RuntimeError(
            f"expected exactly one *_0000.nii.gz case in {input_dir}, found {len(candidates)}"
        )
    fname = candidates[0]
    return fname, fname[: -len("_0000.nii.gz")]


def run_inference(input_dir, output_dir, output_csv_path):
    os.makedirs(output_dir, exist_ok=True)
    fname, case_id = _discover_case(input_dir)
    ct = os.path.join(input_dir, fname)

    t0 = time.time()
    data, props = reader_writer.read_images([ct])
    pm, cm = predictor.plans_manager, predictor.configuration_manager
    preprocessed, _, preprocessed_props = preprocessor.run_case_npy(
        data, None, props, pm, cm, predictor.dataset_json,
    )
    t_infer = time.time()
    logits = predictor.predict_logits_from_preprocessed_data(torch.from_numpy(preprocessed))
    infer_s = round(time.time() - t_infer, 2)

    t_exp = time.time()
    out_trunc = os.path.join(output_dir, case_id)
    # save_probabilities=True is required -- see module docstring, fix 3.
    export_prediction_from_logits(
        logits, preprocessed_props, cm, pm, predictor.dataset_json, out_trunc,
        save_probabilities=True, output_csv_path=output_csv_path,
    )
    export_s = round(time.time() - t_exp, 2)

    del logits, preprocessed
    torch.cuda.empty_cache()

    seconds = round(time.time() - t0, 2)
    out_path = out_trunc + predictor.dataset_json.get("file_ending", ".nii.gz")
    print(f"[warm] {case_id}: done in {seconds}s (infer {infer_s}s, export {export_s}s)", flush=True)
    return {
        "case_id": case_id, "output_path": out_path, "seconds": seconds,
        "infer_seconds": infer_s, "export_seconds": export_s,
    }


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
            "tta_axes": list(TTA_AXES) if TTA_AXES is not None else None,
            "trt_active": TRT_ACTIVE,
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
            # case_id is accepted for schema compatibility with the client but is
            # NEVER used to build a path -- see _discover_case's docstring.
            _ = req["case_id"]
            rel_input = req["input_rel"]
            rel_output = req["output_rel"]
            rel_output_csv = req["output_csv_rel"]
        except Exception as e:
            self._json(400, {"error": f"bad request: {e}"})
            return

        try:
            input_dir = resolve_under_root(rel_input)
            output_dir = resolve_under_root(rel_output)
            output_csv_path = resolve_under_root(rel_output_csv)
        except ValueError as e:
            self._json(400, {"error": str(e)})
            return

        want_step = req.get("step_size")
        want_no_tta = req.get("disable_tta")
        want_axes = req.get("tta_axes")
        want_axes = tuple(want_axes) if want_axes is not None else None
        mismatch = []
        if want_step is not None and abs(float(want_step) - STEP_SIZE) > 1e-9:
            mismatch.append(f"step_size: requested {want_step}, server {STEP_SIZE}")
        if want_no_tta is not None and bool(want_no_tta) != DISABLE_TTA:
            mismatch.append(f"disable_tta: requested {bool(want_no_tta)}, server {DISABLE_TTA}")
        if want_axes is not None and want_axes != TTA_AXES:
            mismatch.append(f"tta_axes: requested {list(want_axes)}, server "
                             f"{list(TTA_AXES) if TTA_AXES else None}")
        if mismatch:
            self._json(409, {"error": "configuration mismatch", "details": mismatch})
            return

        if not os.path.isdir(input_dir):
            self._json(400, {"error": f"input_dir does not exist: {input_dir}"})
            return
        if not os.path.isfile(output_csv_path):
            # auto_segmentor.py's _ensure_output_csv_template writes this before
            # invoking the script -- the fork's export function updates this
            # existing row rather than appending a fresh one (see epai_predict.py).
            self._json(400, {"error": f"output_csv_path does not exist: {output_csv_path}"})
            return

        t0 = time.time()
        if not _lock.acquire(timeout=LOCK_TIMEOUT):
            self._json(503, {"error": "predictor busy, timed out waiting for GPU"})
            return
        try:
            result = run_inference(input_dir, output_dir, output_csv_path)
            _stats["requests"] += 1
            _stats["last_seconds"] = round(time.time() - t0, 2)
            self._json(200, {
                "status": "ok",
                "results": [result],
                "total_seconds": _stats["last_seconds"],
            })
        except Exception as e:
            _stats["failures"] += 1
            traceback.print_exc()
            self._json(500, {"error": f"{type(e).__name__}: {e}"})
        finally:
            _lock.release()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"[warm] listening on 127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
