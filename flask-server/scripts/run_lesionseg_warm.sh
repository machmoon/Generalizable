#!/bin/bash
# Start (or restart) the persistent LesionSegmenter predictor.
#
# Run from a script FILE, never as a nested `bash -lc "..."` over SSH: the quoting
# mangles and the relaunch line can silently not run, which has already caused one
# production outage in this deployment.
#
# setsid detaches the service from the invoking shell so an SSH drop cannot kill it
# mid-start. The kill is scoped to this exact script name -- a broad
# `pkill -f gunicorn`-style pattern would take out unrelated services on this host.
set -u

PORT="${PORT:-8765}"
MODEL="${LESIONSEG_CKPT_PATH:-/home/visitor/model}"
ENV_NAME="${CONDA_ENV_LESIONSEG:-atlasnet}"
PYBIN="${PYBIN:-$HOME/.conda/envs/$ENV_NAME/bin/python}"
LOG="${LOG:-/tmp/lesionseg_warm.log}"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/lesionseg_warm_server.py"

# Settings must match what auto_segmentor.py requests, or the server answers 409 and
# every request silently falls back to the slow cold path.
STEP_SIZE="${STEP_SIZE:-0.7}"
DISABLE_TTA="${DISABLE_TTA:-1}"
BBOX_EXPORT="${BBOX_EXPORT:-0}"

# Directory tree the service may read from and write to. Paths in a /predict
# request are confined to this root, so it must contain the app's per-session
# inference dirs. Defaults to the same place Constants.SESSIONS_DIR_NAME resolves to.
FLASK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LESIONSEG_ROOT="${LESIONSEG_ROOT:-${SESSIONS_DIR_PATH:-$FLASK_DIR/sessions}}"

if [ ! -x "$PYBIN" ]; then
  echo "ERROR: python not found at $PYBIN (set PYBIN or CONDA_ENV_LESIONSEG)" >&2
  exit 1
fi
if [ ! -f "$SCRIPT" ]; then
  echo "ERROR: $SCRIPT not found" >&2
  exit 1
fi

echo "[run_warm] stopping any existing warm predictor on port $PORT"
pkill -f "lesionseg_warm_server.py" 2>/dev/null
sleep 3
if pgrep -f "lesionseg_warm_server.py" >/dev/null; then
  echo "[run_warm] still alive after SIGTERM, sending SIGKILL"
  pkill -9 -f "lesionseg_warm_server.py" 2>/dev/null
  sleep 2
fi

echo "[run_warm] starting: model=$MODEL port=$PORT step=$STEP_SIZE disable_tta=$DISABLE_TTA bbox=$BBOX_EXPORT"
echo "[run_warm] permitted path root: $LESIONSEG_ROOT"
mkdir -p "$LESIONSEG_ROOT"
setsid env \
  MODEL="$MODEL" PORT="$PORT" STEP_SIZE="$STEP_SIZE" \
  DISABLE_TTA="$DISABLE_TTA" BBOX_EXPORT="$BBOX_EXPORT" \
  LESIONSEG_ROOT="$LESIONSEG_ROOT" \
  "$PYBIN" -u "$SCRIPT" > "$LOG" 2>&1 < /dev/null &

# Wait for readiness rather than a guessed sleep; the model load dominates startup.
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
