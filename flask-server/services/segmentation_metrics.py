"""
services/segmentation_metrics.py

Per-session segmentation metrics for the AI assistant when a user is viewing
an *uploaded* (session) case rather than a numeric dataset case.

This module is intentionally defensive. Its only caller
(``api_blueprint._ai_load_metrics``) treats a returned dict that contains an
``"error"`` key as "no server metrics available" and falls back to
frontend-supplied metrics. Therefore this function must NEVER raise and must
always return a dict: a missing/undecodable session mask has to degrade
gracefully to the frontend metrics instead of breaking AI chat -- or, as we
learned the hard way, breaking the whole backend at import time when this
module was referenced but never committed.

Server-side computation of per-organ metrics for uploaded sessions is not
implemented in this build, so we return a clean "unavailable" result. The
public shape mirrors ``get_mask_data_internal`` ({"organ_metrics": [...]}).
"""

from __future__ import annotations


def calculate_session_metrics(session_id, sessions_dir_name=None):
    """Best-effort per-organ metrics for an uploaded session case.

    Returns a dict shaped like ``get_mask_data_internal`` on success, or
    ``{"error": ...}`` when the session's mask cannot be located/computed.
    Never raises.
    """
    try:
        identifier = str(session_id or "").strip()
        if not identifier:
            return {"error": "no session id", "organ_metrics": []}

        # Session masks are not computed server-side in this build; signal
        # "unavailable" so the caller falls back to frontend-supplied metrics.
        return {"error": "session metrics unavailable", "organ_metrics": []}
    except Exception as error:  # never let this break the import or the caller
        return {"error": f"{type(error).__name__}: {error}", "organ_metrics": []}
