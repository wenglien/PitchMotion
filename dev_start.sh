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
YOLO_WEIGHTS="${YOLO_WEIGHTS:-train_tool/runs/detect/baseball_yolo26n_v5/weights/best.pt}"
WEIGHTS="$PROJECT_ROOT/$YOLO_WEIGHTS"

echo -e "${CYAN}SpeedGun 本地開發環境${NC}"
echo "=============================="
echo -e "後端 port：${BACKEND_PORT}"

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

echo ""
echo -e "${CYAN}=============================="
echo -e "後端：http://localhost:${BACKEND_PORT}"
echo -e "API docs：http://localhost:${BACKEND_PORT}/docs"
echo -e "按 Ctrl+C 停止服務"
echo -e "==============================${NC}"
echo ""

trap "echo ''; echo '停止服務...'; kill $BACKEND_PID 2>/dev/null; exit 0" INT TERM

wait
