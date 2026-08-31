#!/usr/bin/env bash
set -euo pipefail

# One-click venv setup + dependency install (macOS/Linux).
#
# Usage:
#   ./scripts/bootstrap_dev.sh
#   REQ_FILE=path/to/requirements.txt ./scripts/bootstrap_dev.sh
#
# Notes:
# - This script is intentionally non-destructive: it creates/uses .venv in repo root.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

REQ_FILE="${REQ_FILE:-requirements.txt}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR 找不到 python3，請先安裝 Python 3.10/3.11" >&2
  exit 1
fi

if [[ ! -f "${REQ_FILE}" ]]; then
  echo "ERROR 找不到 requirements 檔案：${REQ_FILE}" >&2
  echo "   可用 REQ_FILE 指定其他 requirements 檔案。" >&2
  exit 1
fi

echo "== PitchMotion bootstrap =="
echo "Repo: ${ROOT_DIR}"
echo "Requirements: ${REQ_FILE}"

if [[ ! -d ".venv" ]]; then
  echo "建立虛擬環境：.venv"
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

echo "更新 pip..."
python -m pip install -U pip

echo "安裝依賴..."
python -m pip install -r "${REQ_FILE}"

# ── .env 設定 ──────────────────────────────────────────────────────────────
ENV_FILE="${ROOT_DIR}/.env"
ENV_EXAMPLE="${ROOT_DIR}/.env.example"

if [[ ! -f "${ENV_FILE}" ]]; then
  if [[ -f "${ENV_EXAMPLE}" ]]; then
    cp "${ENV_EXAMPLE}" "${ENV_FILE}"
    echo "已從 .env.example 建立 .env"
  fi
else
  echo ".env 已存在，略過建立"
fi

echo
echo "OK 完成。你現在可以："
echo " - 執行環境健檢：python scripts/doctor.py"
echo " - 調整 Python 研究工具設定：編輯 .env（參考 .env.example）"
