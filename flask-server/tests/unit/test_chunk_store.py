"""Unit tests for the chunked-upload staging bookkeeping.

Dependency-light (tmp dirs only, no app/DB/dataset) so they run in CI, matching
test_path_safety.py. These lock in the two guarantees resume depends on: the
sweeper never touches an upload that is still progressing, and the resume index
never skips past a gap.
"""

import os
import time

import pytest

from api.chunk_store import (
    CHUNK_TTL_SECONDS,
    first_missing_chunk,
    received_chunks,
    sweep_stale_uploads,
)


def _make_session(root, session_id, chunk_indices, age_seconds=0):
    session_dir = os.path.join(root, session_id)
    os.makedirs(session_dir, exist_ok=True)
    for index in chunk_indices:
        with open(os.path.join(session_dir, f"chunk-{index}"), "wb") as handle:
            handle.write(b"x")
    if age_seconds:
        stamp = time.time() - age_seconds
        os.utime(session_dir, (stamp, stamp))
    return session_dir


# ---- received_chunks --------------------------------------------------------

def test_lists_chunk_indices_numerically(tmp_path):
    # Sorted as ints, not strings: "chunk-10" must not sort before "chunk-2".
    session_dir = _make_session(str(tmp_path), "sid", [0, 1, 2, 10])
    assert received_chunks(session_dir) == [0, 1, 2, 10]


def test_missing_session_dir_is_empty_not_an_error(tmp_path):
    assert received_chunks(os.path.join(str(tmp_path), "never-existed")) == []


def test_ignores_non_chunk_files(tmp_path):
    session_dir = _make_session(str(tmp_path), "sid", [0])
    os.makedirs(os.path.join(session_dir, "dicom"))
    with open(os.path.join(session_dir, "notes.txt"), "w") as handle:
        handle.write("hi")
    assert received_chunks(session_dir) == [0]


# ---- first_missing_chunk ----------------------------------------------------

@pytest.mark.parametrize("indices,expected", [
    ([], 0),                    # nothing uploaded: start from the beginning
    ([0, 1, 2], 3),             # clean prefix: resume right after it
    ([0, 1, 3], 2),             # gap at 2: rewind to it, don't trust the tail
    ([1, 2, 3], 0),             # chunk 0 missing: everything is suspect
    ([0, 1, 1, 2], 3),          # duplicates are harmless
    ([5, 0, 2, 1], 3),          # unsorted input, gap at 3
])
def test_first_missing_chunk(indices, expected):
    assert first_missing_chunk(indices) == expected


# ---- sweep_stale_uploads ----------------------------------------------------

def test_sweeps_only_dirs_older_than_ttl(tmp_path):
    _make_session(str(tmp_path), "fresh", [0], age_seconds=60)
    _make_session(str(tmp_path), "stale", [0], age_seconds=CHUNK_TTL_SECONDS + 60)

    removed = sweep_stale_uploads(str(tmp_path))

    assert removed == ["stale"]
    assert os.path.isdir(os.path.join(str(tmp_path), "fresh"))
    assert not os.path.exists(os.path.join(str(tmp_path), "stale"))


def test_in_progress_upload_is_never_swept(tmp_path):
    # The regression that matters: a huge upload started long ago but still
    # receiving chunks. Writing a chunk refreshes the dir mtime, so it stays.
    session_dir = _make_session(str(tmp_path), "sid", [0], age_seconds=CHUNK_TTL_SECONDS * 3)
    with open(os.path.join(session_dir, "chunk-1"), "wb") as handle:
        handle.write(b"x")

    assert sweep_stale_uploads(str(tmp_path)) == []
    assert os.path.isdir(session_dir)


def test_missing_root_is_a_noop(tmp_path):
    assert sweep_stale_uploads(os.path.join(str(tmp_path), "absent")) == []


def test_leaves_loose_files_alone(tmp_path):
    stray = os.path.join(str(tmp_path), "stray.txt")
    with open(stray, "w") as handle:
        handle.write("hi")
    stamp = time.time() - CHUNK_TTL_SECONDS * 2
    os.utime(stray, (stamp, stamp))

    assert sweep_stale_uploads(str(tmp_path)) == []
    assert os.path.exists(stray)
