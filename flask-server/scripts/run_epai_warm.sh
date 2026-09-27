#!/bin/bash
# Start (or restart) the persistent ePAI predictor.
#
# Run from a script FILE, never as a nested `bash -lc "..."` over SSH -- see
# run_lesionseg_warm.sh's comment on why (a real production outage already
# happened from that pattern).
#
# setsid detaches the service from the invoking shell so an SSH drop cannot
# kill it mid-start. The kill is scoped to this exact script name.
set -u

PORT="${PORT:-8766}"
MODEL="${EPAI_CKPT_PATH:-/home/visitor/ePAI/model/qchen76_2025_0421/nnUNetTrainer__nnUNetPlans__3d_fullres}"
ENV_NAME="${CONDA_ENV_EPAI:-epai}"
PYBIN="${PYBIN:-$HOME/.conda/envs/$ENV_NAME/bin/python}"
LOG="${LOG:-/tmp/epai_warm.log}"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/epai_warm_server.py"

# Settings must match what auto_segmentor.py requests, or the server answers
# 409 and every request falls back to the slow cold path.
STEP_SIZE="${EPAI_STEP_SIZE:-0.5}"

FLASK_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Same .env fallback as EPAI_WARM_ROOT below -- without it, a restart that
# doesn't explicitly pass EPAI_DISABLE_TTA silently reverts to no-TTA even
# when .env says otherwise (this actually happened deploying EPAI_TTA_AXES).
ENV_FILE_DISABLE_TTA="$(grep -m1 '^EPAI_DISABLE_TTA=' "$FLASK_DIR/.env" 2>/dev/null | cut -d= -f2-)"
DISABLE_TTA="${EPAI_DISABLE_TTA:-${ENV_FILE_DISABLE_TTA:-1}}"

# Falls back to .env's own EPAI_WARM_ROOT (not blanket-sourced -- this is the
# one setting whose default silently defeats the warm predictor rather than
# just failing loudly, so it gets its own safety net). Real requests land in
# BOTH flask-server/sessions (session-based viewer flow) and PanTS-Viewer/tmp
# (the /auto_segment and /run-inference quick-inference flow) -- scoping the
# root to just "sessions" meant every quick-inference request silently fell
# back to the slow cold path, which is exactly what happened here.
ENV_FILE_WARM_ROOT="$(grep -m1 '^EPAI_WARM_ROOT=' "$FLASK_DIR/.env" 2>/dev/null | cut -d= -f2-)"
EPAI_WARM_ROOT="${EPAI_WARM_ROOT:-${SESSIONS_DIR_PATH:-${ENV_FILE_WARM_ROOT:-$FLASK_DIR/sessions}}}"

# In-plane-only mirroring ("1,2") -- validated at n=475+n=332 real-GT cases as
# a strictly better trade than full no-TTA (see epai_warm_server.py's
# docstring). Same .env fallback as EPAI_WARM_ROOT.
ENV_FILE_TTA_AXES="$(grep -m1 '^EPAI_TTA_AXES=' "$FLASK_DIR/.env" 2>/dev/null | cut -d= -f2-)"
TTA_AXES="${EPAI_TTA_AXES:-$ENV_FILE_TTA_AXES}"

# TensorRT FP16 (validated n=1033, see epai_trt_fp16.py) -- opt-in, off unless
# a built .plan is pointed at explicitly. Same .env fallback as EPAI_WARM_ROOT
# so it's not lost on the next person's restart once it's actually enabled.
ENV_FILE_TRT_PLAN="$(grep -m1 '^EPAI_TRT_PLAN_PATH=' "$FLASK_DIR/.env" 2>/dev/null | cut -d= -f2-)"
EPAI_TRT_PLAN_PATH="${EPAI_TRT_PLAN_PATH:-$ENV_FILE_TRT_PLAN}"

if [ ! -x "$PYBIN" ]; then
  echo "ERROR: python not found at $PYBIN (set PYBIN or CONDA_ENV_EPAI)" >&2
  exit 1
fi
if [ ! -f "$SCRIPT" ]; then
  echo "ERROR: $SCRIPT not found" >&2
  exit 1
fi

echo "[run_warm] stopping any existing ePAI warm predictor on port $PORT"
pkill -f "epai_warm_server.py" 2>/dev/null
sleep 3
if pgrep -f "epai_warm_server.py" >/dev/null; then
  echo "[run_warm] still alive after SIGTERM, sending SIGKILL"
  pkill -9 -f "epai_warm_server.py" 2>/dev/null
  sleep 2
fi

echo "[run_warm] starting: model=$MODEL port=$PORT step=$STEP_SIZE disable_tta=$DISABLE_TTA tta_axes=${TTA_AXES:-<all>} trt_plan=${EPAI_TRT_PLAN_PATH:-<off>}"
echo "[run_warm] permitted path root: $EPAI_WARM_ROOT"
mkdir -p "$EPAI_WARM_ROOT"
setsid env \
  EPAI_CKPT_PATH="$MODEL" PORT="$PORT" EPAI_STEP_SIZE="$STEP_SIZE" \
  EPAI_DISABLE_TTA="$DISABLE_TTA" EPAI_WARM_ROOT="$EPAI_WARM_ROOT" \
  EPAI_TTA_AXES="$TTA_AXES" EPAI_TRT_PLAN_PATH="$EPAI_TRT_PLAN_PATH" \
  "$PYBIN" -u "$SCRIPT" > "$LOG" 2>&1 < /dev/null &

for i in $(seq 1 180); do
  sleep 1
  if curl -sf -m 2 "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
    echo "[run_warm] healthy after ${i}s:"
    curl -s -m 3 "http://127.0.0.1:$PORT/health"; echo
    exit 0
  fi
done

echo "[run_warm] ERROR: did not become healthy within 180s. Log tail:" >&2
tail -30 "$LOG" >&2
exit 1
