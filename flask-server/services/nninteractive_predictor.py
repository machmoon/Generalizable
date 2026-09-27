"""
flask-server/services/nninteractive_predictor.py

Talks to the standalone `nninteractive-server` process on bdmap1
(127.0.0.1:1527, model + GPU loaded once at server startup) via
nnInteractiveRemoteInferenceSession.

CONFIRMED end-to-end on bdmap1 against PanTS_00000001 (2026-08-15):
  - add_point_interaction(coords, include_interaction=True)
      coords = [i, j, k]  -> works, produced 142284 voxels on a test seed.
  - add_bbox_interaction(bbox, include_interaction=True)
      bbox = [[x_lo, x_hi], [y_lo, y_hi], [z_lo, z_hi]]  (per-axis pairs,
      NOT two corner points). Exactly one axis must have size == 1 (a 2D
      box on a single slice) -- size == 0 raises ValueError, and all three
      axes > 1 raises "3D bounding box... not supported by the loaded
      model checkpoint" (this checkpoint is 2D-box-only). Produced 16227
      voxels on a 30x30 test box.

Every box prompt is flattened to zero thickness on whichever axis has the
smallest extent -- see _corners_to_axis_pairs(). This matches a box drawn
on one 2D viewport pane, but has NOT yet been verified against a real
frontend box-drag; verify this once wired up.

Since api_blueprint.py's `_ANALYSIS_SLOTS` semaphore already serializes all
calls into `interactive_segment()`, one shared session with no extra locking
here is safe. Gunicorn is `--workers 1 --threads 8` (single process), so this
module-level cache is correctly shared across every request thread.
"""
from __future__ import annotations

import numpy as np

SERVER_URL = "http://127.0.0.1:1527"

_session = None
_cached_case_key: str | None = None
_cached_ct_shape: tuple | None = None
_target_buffer: np.ndarray | None = None


def _get_session():
    global _session
    if _session is None:
        from nnInteractive.inference.remote.remote_session import nnInteractiveRemoteInferenceSession
        _session = nnInteractiveRemoteInferenceSession(server_url=SERVER_URL)
        if not _session.ping():
            raise RuntimeError(
                f"nninteractive-server not reachable at {SERVER_URL} — "
                "check it's running (tmux session 'nninteractive' on bdmap1)."
            )
    return _session


def _ensure_volume_loaded(ct: np.ndarray, case_key: str) -> None:
    global _cached_case_key, _cached_ct_shape, _target_buffer
    session = _get_session()
    if _cached_case_key == case_key and _cached_ct_shape == ct.shape:
        return
    session.set_image(ct[None])
    _target_buffer = np.zeros(ct.shape, dtype=np.uint8)
    session.set_target_buffer(_target_buffer)
    _cached_case_key = case_key
    _cached_ct_shape = ct.shape


def _corners_to_axis_pairs(lo, hi) -> list[list[int]]:
    lo, hi = list(lo), list(hi)
    extents = [hi[d] - lo[d] for d in range(3)]
    flatten_axis = min(range(3), key=lambda d: extents[d])
    pairs = []
    for d in range(3):
        if d == flatten_axis:
            start = lo[d]
            pairs.append([start, start + 1])
        else:
            end = hi[d] if hi[d] > lo[d] else lo[d] + 1
            pairs.append([lo[d], end])
    return pairs


def predict(
    ct: np.ndarray,
    case_key: str,
    point_ijk=None,
    box_ijk=None,
) -> np.ndarray:
    session = _get_session()
    _ensure_volume_loaded(ct, case_key)
    session.reset_interactions()

    if point_ijk is not None:
        session.add_point_interaction(list(point_ijk), include_interaction=True)
    elif box_ijk is not None:
        lo, hi = box_ijk
        axis_pairs = _corners_to_axis_pairs(lo, hi)
        session.add_bbox_interaction(axis_pairs, include_interaction=True)
    else:
        raise ValueError("predict() needs point_ijk or box_ijk")

    return _target_buffer.copy()