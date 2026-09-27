"""Unit tests for conda discovery in the inference runners.

Background: every model was failing on the server with

    Inference failed: Could not find conda. Set CONDA_ACTIVATE_PATH or ensure
    `conda` is on PATH.

gunicorn runs without a login shell, so it never picks up the PATH that conda's
shell init exports and shutil.which("conda") comes back empty. Some runners
already had a hardcoded fallback and some raised, which is why the failure hit
ePAI, Atlas-Net and LesionSegmenter but not OpenVAE or MedFormer.

These cover the shared resolver and, more usefully, assert that no runner goes
back to calling shutil.which directly.
"""

import os
import re

import pytest

from services import auto_segmentor
from services.auto_segmentor import _resolve_conda_exe

MODULE_SRC = os.path.join(os.path.dirname(auto_segmentor.__file__), "auto_segmentor.py")


def test_explicit_env_var_wins(monkeypatch, tmp_path):
    fake = tmp_path / "conda"
    fake.write_text("#!/bin/sh\n")
    monkeypatch.setenv("CONDA_EXE_PATH", str(fake))
    monkeypatch.setattr(auto_segmentor.shutil, "which", lambda _: "/somewhere/else/conda")
    assert _resolve_conda_exe() == str(fake)


def test_ignores_env_var_pointing_at_nothing(monkeypatch):
    """A stale CONDA_EXE_PATH must not shadow a perfectly good PATH lookup."""
    monkeypatch.setenv("CONDA_EXE_PATH", "/does/not/exist/conda")
    monkeypatch.setattr(auto_segmentor.shutil, "which", lambda _: "/usr/bin/conda")
    assert _resolve_conda_exe() == "/usr/bin/conda"


def test_falls_back_to_path(monkeypatch):
    monkeypatch.delenv("CONDA_EXE_PATH", raising=False)
    monkeypatch.setattr(auto_segmentor.shutil, "which", lambda _: "/usr/bin/conda")
    assert _resolve_conda_exe() == "/usr/bin/conda"


def test_falls_back_to_known_install_when_path_is_empty(monkeypatch, tmp_path):
    """The actual server case: conda installed, just not on gunicorn's PATH."""
    monkeypatch.delenv("CONDA_EXE_PATH", raising=False)
    monkeypatch.setattr(auto_segmentor.shutil, "which", lambda _: None)
    real = "/home/apps/anaconda3/condabin/conda"
    monkeypatch.setattr(auto_segmentor.os.path, "exists", lambda p: p == real)
    assert _resolve_conda_exe() == real


def test_returns_empty_when_conda_genuinely_absent(monkeypatch):
    monkeypatch.delenv("CONDA_EXE_PATH", raising=False)
    monkeypatch.setattr(auto_segmentor.shutil, "which", lambda _: None)
    monkeypatch.setattr(auto_segmentor.os.path, "exists", lambda _: False)
    assert _resolve_conda_exe() == ""


def test_resolver_does_not_recurse(monkeypatch):
    """Regression guard.

    A search-and-replace that swaps shutil.which for the resolver will happily
    rewrite the call inside the resolver itself, producing infinite recursion
    that only shows up at request time. Calling it is enough to catch that.
    """
    monkeypatch.delenv("CONDA_EXE_PATH", raising=False)
    monkeypatch.setattr(auto_segmentor.shutil, "which", lambda _: None)
    monkeypatch.setattr(auto_segmentor.os.path, "exists", lambda _: False)
    assert _resolve_conda_exe() == ""      # RecursionError if it self-calls


def test_no_runner_calls_shutil_which_directly():
    """Every runner must go through the resolver.

    This is the bug itself: a runner using shutil.which raises on the server
    while its neighbours, which had a fallback, keep working.
    """
    with open(MODULE_SRC, encoding="utf-8") as fh:
        lines = fh.readlines()

    inside_resolver = False
    offenders = []
    for i, line in enumerate(lines, 1):
        if line.startswith("def _resolve_conda_exe"):
            inside_resolver = True
        elif line.startswith("def ") and inside_resolver:
            inside_resolver = False
        if inside_resolver:
            continue          # the one legitimate call lives here
        if re.search(r'shutil\.which\(\s*["\']conda["\']\s*\)', line):
            offenders.append(i)

    assert not offenders, (
        f"lines {offenders} call shutil.which('conda') directly; "
        f"use _resolve_conda_exe() so the server fallback applies"
    )


# ---------------------------------------------------------------------------
# _env_command: the fix that actually matters.
#
# LesionSegmenter survived the outage because it invoked its env's python
# binary directly and never needed conda on PATH. These pin that behaviour for
# every runner.
# ---------------------------------------------------------------------------

from services.auto_segmentor import _env_command


def test_prefers_the_env_binary_and_never_touches_conda(monkeypatch, tmp_path):
    """The server case. conda is unreachable, but the env binary exists."""
    envs = tmp_path / "envs"
    binp = envs / "epai" / "bin"
    binp.mkdir(parents=True)
    (binp / "python").write_text("#!/bin/sh\n")
    monkeypatch.setenv("CONDA_ENVS_DIR", str(envs))

    def explode(_):
        raise AssertionError("must not need conda when the env binary exists")

    monkeypatch.setattr(auto_segmentor, "_resolve_conda_exe", explode)
    assert _env_command("epai") == str(binp / "python")


def test_finds_console_scripts_not_just_python(monkeypatch, tmp_path):
    """The AtlasNet runners call nnUNetv2_predict_from_modelfolder, not python."""
    envs = tmp_path / "envs"
    binp = envs / "atlasnet" / "bin"
    binp.mkdir(parents=True)
    (binp / "nnUNetv2_predict_from_modelfolder").write_text("#!/bin/sh\n")
    monkeypatch.setenv("CONDA_ENVS_DIR", str(envs))
    got = _env_command("atlasnet", "nnUNetv2_predict_from_modelfolder")
    assert got == str(binp / "nnUNetv2_predict_from_modelfolder")


def test_falls_back_to_conda_run_when_env_binary_is_missing(monkeypatch, tmp_path):
    monkeypatch.setenv("CONDA_ENVS_DIR", str(tmp_path / "nope"))
    monkeypatch.setattr(auto_segmentor, "_resolve_conda_exe", lambda: "/usr/bin/conda")
    got = _env_command("epai")
    assert "run -n epai python" in got and "/usr/bin/conda" in got


def test_error_names_both_things_it_looked_for(monkeypatch, tmp_path):
    """A bare 'Could not find conda' is what made this outage hard to place."""
    monkeypatch.setenv("CONDA_ENVS_DIR", str(tmp_path / "nope"))
    monkeypatch.setattr(auto_segmentor, "_resolve_conda_exe", lambda: "")
    with pytest.raises(RuntimeError) as e:
        _env_command("epai")
    msg = str(e.value)
    assert "epai" in msg and "CONDA_ENVS_DIR" in msg and "CONDA_EXE_PATH" in msg


def test_no_runner_builds_conda_run_by_hand():
    """Runners must go through _env_command so the direct-binary path applies.

    Two exemptions. _env_command itself has to build the fallback, and the ePAI
    branch that runs a bash script cannot use an env binary, so `conda run` is
    genuinely the only option there.
    """
    with open(MODULE_SRC, encoding="utf-8") as fh:
        lines = fh.readlines()

    current_fn = None
    in_epai_script_branch = False
    offenders = []
    for i, line in enumerate(lines, 1):
        if line.startswith("def "):
            current_fn = line[4:].split("(")[0]
            in_epai_script_branch = False
        if "fallback_script_path and os.path.exists" in line:
            in_epai_script_branch = True
        elif line.strip() == "else:" and in_epai_script_branch:
            in_epai_script_branch = False

        if "run -n" not in line or "shlex.quote(conda_exe)" not in line:
            continue
        if current_fn == "_env_command" or in_epai_script_branch:
            continue
        offenders.append(i)

    assert not offenders, (
        f"lines {offenders} build `conda run` by hand; use _env_command() so the "
        f"env-binary path is tried first"
    )
