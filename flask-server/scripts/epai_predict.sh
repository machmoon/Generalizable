#!/bin/bash
# Wrapper for the EPAI_SCRIPT_PATH hook in services/auto_segmentor.py, invoked as:
#   bash epai_predict.sh session_dir case_id input_dir save_dir input_csv output_csv ckpt_path
# The caller has already activated the `epai` conda env, so `python` resolves to the
# fork's interpreter. Delegates to epai_predict.py (GPU-resident export + findings CSV).
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python "$DIR/epai_predict.py" "$@"
