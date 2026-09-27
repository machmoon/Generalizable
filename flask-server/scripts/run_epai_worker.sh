#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   run_epai_worker.sh <input_path> <output_mask_path> <output_csv_path>

INPUT_PATH="${1:-}"
OUTPUT_MASK_PATH="${2:-}"
OUTPUT_CSV_PATH="${3:-}"

if [[ -z "${INPUT_PATH}" || -z "${OUTPUT_MASK_PATH}" ]]; then
  echo "Usage: $0 <input_path> <output_mask_path> <output_csv_path>" >&2
  exit 2
fi

if [[ ! -f "${INPUT_PATH}" ]]; then
  echo "Input file not found: ${INPUT_PATH}" >&2
  exit 2
fi

CONDA_ACTIVATE_PATH="${EPAI_CONDA_ACTIVATE_PATH:-/home/visitor/miniconda3/etc/profile.d/conda.sh}"
CONDA_ENV_NAME="${EPAI_CONDA_ENV:-epai}"

EPAI_CKPT_PATH="${EPAI_CKPT_PATH:-/home/visitor/ePAI/model/qchen76_2025_0421/nnUNetTrainer__nnUNetPlans__3d_fullres}"
EPAI_NNUNET_RAW="${EPAI_NNUNET_RAW:-/home/visitor/ePAI/nnUNet/raw}"
EPAI_NNUNET_PREPROCESSED="${EPAI_NNUNET_PREPROCESSED:-/home/visitor/ePAI/nnUNet/preprocessed}"
EPAI_NNUNET_RESULTS="${EPAI_NNUNET_RESULTS:-/home/visitor/ePAI/nnUNet/results}"
EPAI_N_PROC_DA="${EPAI_N_PROC_DA:-36}"
EPAI_NPP="${EPAI_NPP:-3}"
EPAI_NPS="${EPAI_NPS:-3}"
EPAI_CHECKPOINT_NAME="${EPAI_CHECKPOINT_NAME:-checkpoint_final.pth}"
CUDA_DEVICE="${EPAI_GPU:-0}"

SAFE_CASE_ID="$(basename "${INPUT_PATH}" | sed -E 's/\.nii(\.gz)?$//' | sed -E 's/[^A-Za-z0-9_]+/_/g')"
if [[ -z "${SAFE_CASE_ID}" ]]; then
  SAFE_CASE_ID="CASE_$(date +%s)"
fi

WORK_ROOT="$(mktemp -d /tmp/epai_worker_XXXXXX)"
trap 'rm -rf "${WORK_ROOT}"' EXIT

INPUT_DIR="${WORK_ROOT}/eval"
OUT_DIR="${WORK_ROOT}/out"
mkdir -p "${INPUT_DIR}" "${OUT_DIR}"

ln -s "${INPUT_PATH}" "${INPUT_DIR}/${SAFE_CASE_ID}_0000.nii.gz"

INPUT_CSV="${WORK_ROOT}/input.csv"
RESULT_CSV="${WORK_ROOT}/output.csv"

cat > "${INPUT_CSV}" <<EOF
BDMAP ID
${SAFE_CASE_ID}
EOF

if [[ -n "${OUTPUT_CSV_PATH}" ]]; then
  cat > "${RESULT_CSV}" <<EOF
bdmap_id
${SAFE_CASE_ID}
EOF
fi

if [[ ! -f "${CONDA_ACTIVATE_PATH}" ]]; then
  echo "Conda activate script not found: ${CONDA_ACTIVATE_PATH}" >&2
  exit 2
fi

source "${CONDA_ACTIVATE_PATH}"
conda activate "${CONDA_ENV_NAME}"

export nnUNet_N_proc_DA="${EPAI_N_PROC_DA}"
export nnUNet_raw="${EPAI_NNUNET_RAW}"
export nnUNet_preprocessed="${EPAI_NNUNET_PREPROCESSED}"
export nnUNet_results="${EPAI_NNUNET_RESULTS}"

CUDA_VISIBLE_DEVICES="${CUDA_DEVICE}" nnUNetv2_predict_from_modelfolder \
  -i "${INPUT_DIR}" \
  -o "${OUT_DIR}" \
  -m "${EPAI_CKPT_PATH}" \
  -f all \
  --input_csv "${INPUT_CSV}" \
  --output_csv "${RESULT_CSV}" \
  --continue_prediction \
  --save_probabilities \
  -npp "${EPAI_NPP}" \
  -nps "${EPAI_NPS}" \
  -num_parts 1 \
  -part_id 0 \
  -chk "${EPAI_CHECKPOINT_NAME}"

PRED_FILE="${OUT_DIR}/${SAFE_CASE_ID}.nii.gz"
if [[ ! -f "${PRED_FILE}" ]]; then
  echo "Expected prediction not found: ${PRED_FILE}" >&2
  exit 3
fi

mkdir -p "$(dirname "${OUTPUT_MASK_PATH}")"
cp -f "${PRED_FILE}" "${OUTPUT_MASK_PATH}"

if [[ -n "${OUTPUT_CSV_PATH}" && -f "${RESULT_CSV}" ]]; then
  mkdir -p "$(dirname "${OUTPUT_CSV_PATH}")"
  cp -f "${RESULT_CSV}" "${OUTPUT_CSV_PATH}"
fi

echo "Inference complete: ${OUTPUT_MASK_PATH}"
