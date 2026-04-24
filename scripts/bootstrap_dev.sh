#!/usr/bin/env bash
set -euo pipefail

# One-click venv setup + dependency install (macOS/Linux).
#
# Usage:
#   ./scripts/bootstrap_dev.sh
#   REQ_FILE=requirements-yolov8.txt ./scripts/bootstrap_dev.sh
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

# ── Node.js 版本檢查 ────────────────────────────────────────────────────────
NVMRC="${ROOT_DIR}/frontend/.nvmrc"
REQUIRED_NODE="$(cat "${NVMRC}" 2>/dev/null | tr -d '[:space:]')"
if command -v node >/dev/null 2>&1; then
  CURRENT_NODE="$(node --version | sed 's/v//' | cut -d. -f1)"
  if [[ -n "${REQUIRED_NODE}" && "${CURRENT_NODE}" -lt "${REQUIRED_NODE}" ]] 2>/dev/null; then
    echo "WARN Node.js v${CURRENT_NODE} 過舊（需要 v${REQUIRED_NODE}+）"
    echo "     前端（Vite）無法啟動，請先升級 Node.js："
    echo "       nvm install ${REQUIRED_NODE} && nvm use ${REQUIRED_NODE}"
    echo "     或從 https://nodejs.org 下載安裝 Node.js ${REQUIRED_NODE}+"
    echo "     Python 後端環境仍會繼續安裝。"
  else
    echo "OK Node.js v${CURRENT_NODE}"
  fi
else
  echo "WARN 找不到 node，前端需要 Node.js ${REQUIRED_NODE}+，請先安裝"
fi

if [[ ! -f "${REQ_FILE}" ]]; then
  echo "ERROR 找不到 requirements 檔案：${REQ_FILE}" >&2
  echo "   你可以改用：REQ_FILE=requirements-yolov8.txt ./scripts/bootstrap_dev.sh" >&2
  exit 1
fi

echo "== Speedgun bootstrap =="
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
    echo "已從 .env.example 建立 .env（如需自訂 port 請編輯 .env）"
  fi
else
  echo ".env 已存在，略過建立"
fi

echo
echo "OK 完成。你現在可以："
echo " - 啟動前後端：./dev_start.sh"
echo " - 執行環境健檢：python scripts/doctor.py"
echo " - 自訂 port：編輯 .env（參考 .env.example）"

