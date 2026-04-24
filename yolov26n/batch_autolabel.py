from __future__ import annotations

import random
import shutil
from pathlib import Path

YOLOV8_DIR   = Path(__file__).resolve().parent
DATASET_ROOT = YOLOV8_DIR / "datasets" / "baseball"

STAGING_IMAGES = DATASET_ROOT / "images" / "_staging"
STAGING_LABELS = DATASET_ROOT / "labels" / "_staging"

TRAIN_IMAGES = DATASET_ROOT / "images" / "train"
TRAIN_LABELS = DATASET_ROOT / "labels" / "train"
VAL_IMAGES   = DATASET_ROOT / "images" / "val"
VAL_LABELS   = DATASET_ROOT / "labels" / "val"

VAL_RATIO = 0.2
SEED      = 42


def main() -> None:
    # 建立輸出目錄
    for d in (TRAIN_IMAGES, TRAIN_LABELS, VAL_IMAGES, VAL_LABELS):
        d.mkdir(parents=True, exist_ok=True)

    # 收集 staging 中有對應 label 的圖片
    all_stems = sorted(
        p.stem for p in STAGING_IMAGES.glob("*.jpg")
        if (STAGING_LABELS / f"{p.stem}.txt").exists()
    )

    if not all_stems:
        print("⚠  _staging/ 中沒有找到任何已標注的資料（需要同時有 .jpg 和 .txt）。")
        print("   請先執行 manual_label.py 進行手動標注。")
        return

    random.seed(SEED)
    random.shuffle(all_stems)

    n_val   = max(1, int(len(all_stems) * VAL_RATIO))
    val_set = set(all_stems[:n_val])

    copied_train = 0
    copied_val   = 0

    for stem in all_stems:
        src_img = STAGING_IMAGES / f"{stem}.jpg"
        src_lbl = STAGING_LABELS / f"{stem}.txt"

        if stem in val_set:
            dst_img = VAL_IMAGES   / f"{stem}.jpg"
            dst_lbl = VAL_LABELS   / f"{stem}.txt"
            copied_val += 1
        else:
            dst_img = TRAIN_IMAGES / f"{stem}.jpg"
            dst_lbl = TRAIN_LABELS / f"{stem}.txt"
            copied_train += 1

        shutil.copy2(src_img, dst_img)
        shutil.copy2(src_lbl, dst_lbl)

    total = copied_train + copied_val
    print(f"✅ 分割完成：{total} 筆  →  train={copied_train}, val={copied_val}")
    print(f"   train: {TRAIN_IMAGES}")
    print(f"   val:   {VAL_IMAGES}")
    print("\n接下來執行訓練：")
    print("  python train_yolo26.py   # 開始訓練（YOLO26n）")


if __name__ == "__main__":
    main()
