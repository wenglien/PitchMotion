"""
Train baseball_yolo26n_v5
修正重點：
- lr0: 0.01 → 0.001  (降低 10x，fine-tune 更保守)
- lrf: 0.01 → 0.01   (lrf 是 lr0 的倍率，最終 lr = lr0 * lrf = 0.00001)
- patience: 10 → 30   (給更多機會收斂)
- epochs: 50 → 100    (充分訓練)
- cos_lr: True         (cosine annealing，讓 lr 平滑下降)
- freeze: 10           (凍結前 10 層 backbone，只訓練 head，防止 catastrophic forgetting)
- warmup_epochs: 5    (更長 warmup)
"""

from pathlib import Path

from ultralytics import YOLO

_ROOT = Path(__file__).resolve().parent.parent
_V4_PT = _ROOT / "train_tool/runs/detect/baseball_yolo26n_v5/weights/best.pt"

model = YOLO(str(_V4_PT))

results = model.train(
    data=str(_ROOT / "yolov26n/data_baseball.yaml"),
    epochs=100,
    patience=30,
    batch=8,
    imgsz=640,
    device="mps",
    workers=0,
    project=str(_ROOT / "train_tool/runs/detect"),
    name="baseball_yolo26n_v5",
    exist_ok=False,

    # Learning rate — 核心修正
    lr0=0.001,       # 原本 0.01，降低 10x
    lrf=0.01,        # 最終 lr = lr0 * lrf = 0.00001
    cos_lr=True,     # cosine annealing，平滑下降

    # Freeze backbone 防止破壞已學好的特徵
    freeze=10,       # 凍結前 10 層

    # Warmup
    warmup_epochs=5,
    warmup_momentum=0.8,
    warmup_bias_lr=0.01,  # 也跟著降

    # 其他維持不變
    momentum=0.937,
    weight_decay=0.0005,
    optimizer="auto",
    amp=True,
    seed=0,

    # Augmentation
    hsv_h=0.015,
    hsv_s=0.7,
    hsv_v=0.4,
    translate=0.1,
    scale=0.5,
    fliplr=0.5,
    mosaic=1.0,
    erasing=0.4,
    close_mosaic=10,

    plots=True,
    save=True,
    verbose=True,
)

print("\n✅ 訓練完成")
print(f"最佳模型: {results.save_dir}/weights/best.pt")
