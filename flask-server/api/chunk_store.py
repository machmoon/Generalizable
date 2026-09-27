"""Bookkeeping for the resumable chunked-upload staging area (/tmp/uploads).

A chunked upload writes ``<root>/<session_id>/chunk-N`` per chunk and
``finalize-upload`` concatenates then deletes them. Two things were missing:

1. Nothing ever cleaned up an upload the user *abandoned* — a tab closed
   mid-transfer left its chunks on disk forever. ``sweep_stale_uploads``
   reclaims session dirs untouched for longer than ``CHUNK_TTL_SECONDS``.
2. A resuming client had no way to ask what the server actually still has, so
   it trusted its own cursor and could finalize over gaps.
   ``first_missing_chunk`` gives it ground truth instead.

Kept dependency-light (stdlib only, no app/DB/dataset) so it can be unit-tested
in CI — same rationale as path_safety.py.
"""

import os
import re
import shutil
import time

# How long an interrupted upload stays resumable. A tab closed over lunch or
# overnight resumes without re-sending; anything older is treated as abandoned
# and its (often hundreds of MB) partial scan is reclaimed.
CHUNK_TTL_SECONDS = 24 * 60 * 60

_CHUNK_RE = re.compile(r"^chunk-(\d+)$")


def received_chunks(session_dir):
    """Sorted indices of chunks in an already-resolved staging directory.

    Returns ``[]`` when the session has no staging dir (never started, already
    finalized, or swept). Resolving and authorizing the directory remains the
    caller's responsibility, so this helper never builds a path from a request
    value.
    """
    try:
        names = os.listdir(session_dir)
    except (FileNotFoundError, NotADirectoryError):
        return []
    indices = []
    for name in names:
        match = _CHUNK_RE.match(name)
        if match:
            indices.append(int(match.group(1)))
    return sorted(indices)


def first_missing_chunk(indices):
    """Length of the contiguous 0..N-1 prefix in ``indices``.

    This is the index a resuming client should start from: everything before it
    is definitely on disk, so re-sending it would be wasted bytes. A gap makes
    the whole tail suspect (finalize concatenates by index), so the first hole
    wins even if later chunks exist.
    """
    expected = 0
    for index in sorted(indices):
        if index > expected:
            break
        if index == expected:
            expected += 1
    return expected


def sweep_stale_uploads(root, ttl_seconds=CHUNK_TTL_SECONDS, now=None):
    """Delete session dirs under ``root`` untouched for ``ttl_seconds``.

    Age is directory mtime, which a chunk write refreshes — so an upload still
    making progress is never swept no matter how large the file is. Returns the
    session ids removed. Best-effort: a dir that vanishes or can't be removed
    mid-sweep is skipped rather than failing the caller (this runs inline on an
    upload request).
    """
    now = time.time() if now is None else now
    cutoff = now - ttl_seconds
    removed = []
    try:
        entries = os.listdir(root)
    except FileNotFoundError:
        return removed
    for name in entries:
        path = os.path.join(root, name)
        try:
            if not os.path.isdir(path):
                continue
            if os.path.getmtime(path) >= cutoff:
                continue
            shutil.rmtree(path)
            removed.append(name)
        except OSError:
            continue
    return removed
