#!/bin/bash
# 即時監看訓練進度
# 用法: bash yolov8/watch_training.sh

CSV="/Users/wenglien/speedgun-mobile/yolov8/runs/detect/baseball_yolo26n_v5/results.csv"

echo "等待訓練開始..."
while [ ! -f "$CSV" ]; do sleep 2; done

echo "訓練開始！每 10 秒更新一次 (Ctrl+C 停止監看，不影響訓練)"
echo ""

while true; do
    clear
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  SpeedGun v5 訓練進度  $(date '+%H:%M:%S')"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    # 標頭
    echo ""
    printf "%-6s  %-10s %-10s  %-10s %-10s  %-8s\n" \
        "Epoch" "box_loss" "cls_loss" "mAP50" "mAP50-95" "Recall"
    echo "------  ---------- ----------  ---------- ----------  --------"
    
    # 最近 10 個 epoch
    tail -n +2 "$CSV" | tail -10 | while IFS=',' read -r epoch _ _ \
        train_box train_cls _ _ _ _ _ val_box val_cls _ prec recall map50 map5095 _; do
        printf "%-6s  %-10s %-10s  %-10s %-10s  %-8s\n" \
            "$(echo $epoch | xargs)" \
            "$(printf '%.4f' $train_box 2>/dev/null || echo $train_box)" \
            "$(printf '%.4f' $train_cls 2>/dev/null || echo $train_cls)" \
            "$(printf '%.4f' $map50 2>/dev/null || echo $map50)" \
            "$(printf '%.4f' $map5095 2>/dev/null || echo $map5095)" \
            "$(printf '%.4f' $recall 2>/dev/null || echo $recall)"
    done
    
    echo ""
    # 目前最佳
    BEST=$(tail -n +2 "$CSV" | sort -t',' -k17 -rn | head -1)
    BEST_EPOCH=$(echo "$BEST" | cut -d',' -f1 | xargs)
    BEST_MAP=$(echo "$BEST" | cut -d',' -f17 | xargs)
    TOTAL=$(tail -n +2 "$CSV" | wc -l | xargs)
    
    echo "  目前 Epoch: $TOTAL / 100"
    echo "  最佳 Epoch: $BEST_EPOCH  (mAP50: $BEST_MAP)"
    echo ""
    echo "  (按 Ctrl+C 停止監看，不影響背景訓練)"
    
    sleep 10
done
