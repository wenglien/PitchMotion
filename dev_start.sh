#!/usr/bin/env bash
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
VENV="$PROJECT_ROOT/.venv"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── 讀取 .env 設定（若不存在則從 .env.example 建立）──────────────────────
ENV_FILE="$PROJECT_ROOT/.env"
ENV_EXAMPLE="$PROJECT_ROOT/.env.example"

if [ ! -f "$ENV_FILE" ]; then
  if [ -f "$ENV_EXAMPLE" ]; then
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    echo -e "${YELLOW}⚠  .env 不存在，已從 .env.example 自動建立。如需自訂 port 請編輯 .env${NC}"
  else
    echo -e "${RED}找不到 .env 也找不到 .env.example，請確認 repo 完整。${NC}"
    exit 1
  fi
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
YOLO_WEIGHTS="${YOLO_WEIGHTS:-train_tool/runs/detect/baseball_yolo26n_v5/weights/best.pt}"
WEIGHTS="$PROJECT_ROOT/$YOLO_WEIGHTS"

echo -e "${CYAN}SpeedGun 本地開發環境${NC}"
echo "=============================="
echo -e "後端 port：${BACKEND_PORT}  前端 port：${FRONTEND_PORT}"

# ── 環境檢查 ─────────────────────────────────────────────────────────────
if [ ! -f "$VENV/bin/activate" ]; then
  echo -e "${RED}找不到虛擬環境：$VENV${NC}"
  echo "請先執行：./scripts/bootstrap_dev.sh"
  exit 1
fi

if [ ! -f "$WEIGHTS" ]; then
  echo -e "${YELLOW}⚠  找不到 YOLO 權重：$WEIGHTS${NC}"
  echo "   後端會啟動但分析功能無法使用，直到放入權重檔"
else
  echo -e "${GREEN}✓ YOLO 權重：$WEIGHTS${NC}"
fi

# ── 清理舊的 process ──────────────────────────────────────────────────────
echo ""
echo "清理舊的 process..."
lsof -ti:"$BACKEND_PORT"  | xargs kill -9 2>/dev/null || true
lsof -ti:"$FRONTEND_PORT" | xargs kill -9 2>/dev/null || true
sleep 0.5

# ── 啟動後端 ──────────────────────────────────────────────────────────────
echo -e "${GREEN}▶ 啟動後端 (port ${BACKEND_PORT})...${NC}"
(
  source "$VENV/bin/activate"
  cd "$PROJECT_ROOT"
  export YOLO_WEIGHTS="$WEIGHTS"
  export PYTHONPATH="$PROJECT_ROOT"
  export BACKEND_PORT="$BACKEND_PORT"
  uvicorn backend.main:app --host 0.0.0.0 --port "$BACKEND_PORT" --reload \
    2>&1 | sed 's/^/[backend] /'
) &
BACKEND_PID=$!

# ── Node.js 版本檢查 + nvm 切換 ──────────────────────────────────────────
_NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
_NVMRC="$PROJECT_ROOT/frontend/.nvmrc"
_REQUIRED_NODE="$(cat "$_NVMRC" 2>/dev/null | tr -d '[:space:]')"   # e.g. "22"

_load_nvm() {
  # 嘗試從常見位置 source nvm
  for _f in "$_NVM_DIR/nvm.sh" "/opt/homebrew/opt/nvm/nvm.sh" "/usr/local/opt/nvm/nvm.sh"; do
    [ -s "$_f" ] && { source "$_f" --no-use; return 0; }
  done
  return 1
}

_node_major() { node --version 2>/dev/null | sed 's/v//' | cut -d. -f1; }

_switch_node() {
  if _load_nvm 2>/dev/null; then
    if nvm use --silent 2>/dev/null; then
      echo -e "${GREEN}✓ Node.js $(node --version)（nvm use 成功）${NC}"
      return 0
    elif nvm install "$_REQUIRED_NODE" >/dev/null 2>&1 && nvm use "$_REQUIRED_NODE" --silent 2>/dev/null; then
      echo -e "${GREEN}✓ Node.js $(node --version)（nvm install + use 成功）${NC}"
      return 0
    fi
  fi
  return 1
}

_cur_major="$(_node_major)"
if [ -n "$_REQUIRED_NODE" ] && [ "${_cur_major:-0}" -lt "$_REQUIRED_NODE" ] 2>/dev/null; then
  echo -e "${YELLOW}⚠  Node.js v${_cur_major} 過舊，需要 v${_REQUIRED_NODE}+，嘗試 nvm 切換...${NC}"
  if ! _switch_node; then
    echo -e "${RED}無法自動切換 Node.js 版本。請手動執行：${NC}"
    echo "  nvm install ${_REQUIRED_NODE} && nvm use ${_REQUIRED_NODE}"
    echo "  或從 https://nodejs.org 下載安裝 Node.js ${_REQUIRED_NODE}+"
    kill $BACKEND_PID 2>/dev/null
    exit 1
  fi
else
  echo -e "${GREEN}✓ Node.js $(node --version)${NC}"
fi

# ── 啟動前端 ──────────────────────────────────────────────────────────────
echo -e "${GREEN}▶ 啟動前端 (port ${FRONTEND_PORT})...${NC}"
(
  # 子 shell 也需要 source nvm，否則切換不會繼承
  _load_nvm 2>/dev/null && nvm use --silent 2>/dev/null || true
  cd "$PROJECT_ROOT/frontend"
  export BACKEND_PORT="$BACKEND_PORT"
  npm run dev -- --port "$FRONTEND_PORT" 2>&1 | sed 's/^/[frontend] /'
) &
FRONTEND_PID=$!

echo ""
echo -e "${CYAN}=============================="
echo -e "前端：http://localhost:${FRONTEND_PORT}"
echo -e "後端：http://localhost:${BACKEND_PORT}"
echo -e "API docs：http://localhost:${BACKEND_PORT}/docs"
echo -e "按 Ctrl+C 停止所有服務"
echo -e "==============================${NC}"
echo ""

trap "echo ''; echo '停止服務...'; kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit 0" INT TERM

wait
