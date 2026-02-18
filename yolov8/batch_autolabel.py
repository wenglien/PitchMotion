"""
棒球訓練資料標註（唯一入口）：對 videos/ 下所有影片做自動標註，
產生 YOLO 格式訓練資料並自動分割 train/val。
使用 YOLO 推論 + 棒球過濾（尺寸、長寬比、NMS 去重、邊緣過濾）以提升標註品質。

預設針對 120fps 影片調校（較高 conf、較嚴長寬比、較嚴 NMS、邊緣過濾）。

用法：
  cd yolov8
  python batch_autolabel.py

  # 自訂參數（120fps 預設：stride=4 → 約 30fps 取樣，conf=0.20）
  python batch_autolabel.py --stride 4 --conf 0.20 --val-ratio 0.15
"""

from __future__ import annotations

import argparse
import random
import shutil
import sys
from pathlib import Path

import cv2
from ultralytics import YOLO

# 路徑設定
ROOT = Path(__file__).resolve().parents[1]
YOLOV8_DIR = Path(__file__).resolve().parent
VIDEOS_DIR = ROOT / "videos"
DATASET_ROOT = YOLOV8_DIR / "datasets" / "baseball"

# 暫存目錄（先全部標註到這裡，最後再分 train/val）
STAGING_IMAGES = DATASET_ROOT / "images" / "_staging"
STAGING_LABELS = DATASET_ROOT / "labels" / "_staging"

IMAGES_TRAIN = DATASET_ROOT / "images" / "train"
IMAGES_VAL = DATASET_ROOT / "images" / "val"
LABELS_TRAIN = DATASET_ROOT / "labels" / "train"
LABELS_VAL = DATASET_ROOT / "labels" / "val"

DEFAULT_WEIGHTS = YOLOV8_DIR / "runs" / "detect" / "baseball_yolo11n" / "weights" / "best.pt"

# ===== 棒球過濾參數（針對 120fps：動態模糊小，球更接近正圓）=====
MIN_SIZE = 0.002          # 放寬以捕捉遠距離小球（4K 下球可 <0.3%）
MAX_SIZE = 0.12          # 收緊以避免過大誤檢（原 0.20 易含非球物體）
MIN_ASPECT_RATIO = 0.5   # 120fps 模糊較小，長寬比收緊
MAX_ASPECT_RATIO = 2.0
NMS_IOU_THRESHOLD = 0.25 # 同幀重複框合併更積極，減少多標
EDGE_MARGIN = 0.01       # 邊緣 1% 內排除（邊緣常為誤檢）

VIDEO_EXTS = {".mp4", ".avi", ".mov", ".mkv"}


def compute_iou(box1, box2):
    cx1, cy1, w1, h1 = box1
    cx2, cy2, w2, h2 = box2
    x1_min, y1_min = cx1 - w1 / 2, cy1 - h1 / 2
    x1_max, y1_max = cx1 + w1 / 2, cy1 + h1 / 2
    x2_min, y2_min = cx2 - w2 / 2, cy2 - h2 / 2
    x2_max, y2_max = cx2 + w2 / 2, cy2 + h2 / 2
    inter_x1 = max(x1_min, x2_min)
    inter_y1 = max(y1_min, y2_min)
    inter_x2 = min(x1_max, x2_max)
    inter_y2 = min(y1_max, y2_max)
    if inter_x2 <= inter_x1 or inter_y2 <= inter_y1:
        return 0.0
    inter_area = (inter_x2 - inter_x1) * (inter_y2 - inter_y1)
    union_area = w1 * h1 + w2 * h2 - inter_area
    return inter_area / union_area if union_area > 0 else 0.0


def nms_filter(detections):
    if not detections:
        return []
    sorted_dets = sorted(detections, key=lambda x: x[4], reverse=True)
    kept = []
    while sorted_dets:
        best = sorted_dets.pop(0)
        best_box = (best[0], best[1], best[2], best[3])
        kept.append(best_box)
        sorted_dets = [
            d for d in sorted_dets
            if compute_iou(best_box, (d[0], d[1], d[2], d[3])) < NMS_IOU_THRESHOLD
        ]
    return kept


def is_valid_baseball(cx, cy, w, h):
    if w < MIN_SIZE or h < MIN_SIZE:
        return False
    if w > MAX_SIZE or h > MAX_SIZE:
        return False
    aspect_ratio = w / h if h > 0 else 0
    if aspect_ratio < MIN_ASPECT_RATIO or aspect_ratio > MAX_ASPECT_RATIO:
        return False
    if cx < EDGE_MARGIN or cx > (1 - EDGE_MARGIN):
        return False
    if cy < EDGE_MARGIN or cy > (1 - EDGE_MARGIN):
        return False
    return True


def _infer_ball_class_ids(model, first_result):
    names = getattr(first_result, "names", None) or getattr(model, "names", None)
    if names is None:
        return None
    if isinstance(names, dict):
        name_map = {int(k): str(v) for k, v in names.items()}
    elif isinstance(names, (list, tuple)):
        name_map = {i: str(n) for i, n in enumerate(names)}
    else:
        return None
    if len(name_map) == 1:
        return set(name_map.keys())
    keywords = ("baseball", "ball")
    ball_ids = {cid for cid, name in name_map.items() if any(k in name.lower() for k in keywords)}
    return ball_ids or None


def process_video(video_path, model, *, stride, conf, imgsz, out_images, out_labels):
    """對單一影片逐幀偵測並儲存標註，回傳寫入數量。"""
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(f"  [錯誤] 無法開啟：{video_path}", file=sys.stderr)
        return 0

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    if width <= 0 or height <= 0:
        cap.release()
        return 0

    saved = 0
    frame_idx = 0
    ball_class_ids = None

    while True:
        ok, frame = cap.read()
        if not ok:
            break

        if frame_idx % stride != 0:
            frame_idx += 1
            continue

        # 推論時 NMS iou=0.35，與後處理 NMS 搭配減少重複框
        results = model.predict(source=frame, conf=conf, iou=0.35, imgsz=imgsz, verbose=False)
        if not results:
            frame_idx += 1
            continue

        result = results[0]
        if ball_class_ids is None:
            ball_class_ids = _infer_ball_class_ids(model, result)

        candidates = []
        for box in result.boxes:
            x1, y1, x2, y2 = box.xyxy[0].tolist()
            score = float(box.conf[0].item())
            cls_id = int(box.cls[0].item()) if box.cls is not None else 0
            if ball_class_ids is not None and cls_id not in ball_class_ids:
                continue
            cx = ((x1 + x2) / 2.0) / width
            cy = ((y1 + y2) / 2.0) / height
            w = (x2 - x1) / width
            h = (y2 - y1) / height
            if w <= 0 or h <= 0:
                continue
            if not is_valid_baseball(cx, cy, w, h):
                continue
            candidates.append((cx, cy, w, h, score))

        dets = nms_filter(candidates)
        if not dets:
            frame_idx += 1
            continue

        base_name = f"{video_path.stem}_{frame_idx:06d}"
        img_path = out_images / f"{base_name}.jpg"
        label_path = out_labels / f"{base_name}.txt"

        cv2.imwrite(str(img_path), frame)
        with open(label_path, "w", encoding="utf-8") as f:
            for cx, cy, w, h in dets:
                f.write(f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}\n")

        saved += 1
        frame_idx += 1

        if saved % 50 == 0:
            print(f"    進度：{frame_idx}/{total_frames} 幀，已儲存 {saved} 筆")

    cap.release()
    return saved


def collect_videos(videos_dir):
    """收集所有影片檔案路徑。"""
    videos = []
    for f in sorted(videos_dir.iterdir()):
        if f.is_file() and f.suffix.lower() in VIDEO_EXTS:
            videos.append(f)
        elif f.is_dir():
            for sub_f in sorted(f.rglob("*")):
                if sub_f.is_file() and sub_f.suffix.lower() in VIDEO_EXTS:
                    videos.append(sub_f)
    return videos


def split_train_val(staging_images, staging_labels, val_ratio, seed=42):
    """
    將 staging 中的新資料與既有 train/val 合併，重新分割。
    保留既有資料，只對新產生的資料做分割。
    """
    # 收集新標註的檔案（staging 中的）
    new_stems = sorted({f.stem for f in staging_images.glob("*.jpg")})
    if not new_stems:
        print("沒有新的標註資料需要分割。")
        return

    random.seed(seed)
    random.shuffle(new_stems)

    n_val = max(1, int(len(new_stems) * val_ratio))
    val_stems = set(new_stems[:n_val])
    train_stems = set(new_stems[n_val:])

    moved_train = 0
    moved_val = 0

    for stem in train_stems:
        img_src = staging_images / f"{stem}.jpg"
        lbl_src = staging_labels / f"{stem}.txt"
        if img_src.exists():
            shutil.move(str(img_src), str(IMAGES_TRAIN / img_src.name))
            moved_train += 1
        if lbl_src.exists():
            shutil.move(str(lbl_src), str(LABELS_TRAIN / lbl_src.name))

    for stem in val_stems:
        img_src = staging_images / f"{stem}.jpg"
        lbl_src = staging_labels / f"{stem}.txt"
        if img_src.exists():
            shutil.move(str(img_src), str(IMAGES_VAL / img_src.name))
            moved_val += 1
        if lbl_src.exists():
            shutil.move(str(lbl_src), str(LABELS_VAL / lbl_src.name))

    print(f"\n新資料分割完成：{moved_train} 張 -> train，{moved_val} 張 -> val")

    # 清理 staging 目錄
    shutil.rmtree(str(staging_images), ignore_errors=True)
    shutil.rmtree(str(staging_labels), ignore_errors=True)


def main():
    parser = argparse.ArgumentParser(description="批次自動標註所有影片並分割 train/val")
    parser.add_argument("-w", "--weights", type=Path, default=DEFAULT_WEIGHTS,
                        help=f"YOLO 權重檔（預設：{DEFAULT_WEIGHTS}）")
    parser.add_argument("--stride", type=int, default=4,
                        help="每 N 幀取一張（預設 4，120fps → 約 30fps 取樣，平衡多樣性與重複）")
    parser.add_argument("--conf", type=float, default=0.20,
                        help="偵測置信度閾值（預設 0.20，120fps 下提高以減少誤檢）")
    parser.add_argument("--imgsz", type=int, default=1280,
                        help="YOLO 推論輸入尺寸（預設 1280，利於 4K 下小球偵測）")
    parser.add_argument("--val-ratio", type=float, default=0.15,
                        help="驗證集比例（預設 0.15）")
    args = parser.parse_args()

    # 確認權重
    weights_path = args.weights
    if not weights_path.is_absolute():
        weights_path = (YOLOV8_DIR / weights_path).resolve()
    if not weights_path.exists():
        print(f"找不到權重檔：{weights_path}", file=sys.stderr)
        sys.exit(1)

    # 收集影片
    videos = collect_videos(VIDEOS_DIR)
    if not videos:
        print(f"在 {VIDEOS_DIR} 中找不到任何影片。", file=sys.stderr)
        sys.exit(1)

    print(f"找到 {len(videos)} 部影片")
    print(f"權重檔：{weights_path}")
    print(f"參數：stride={args.stride}, conf={args.conf}, imgsz={args.imgsz}")
    print(f"驗證集比例：{args.val_ratio}")
    print("=" * 60)

    # 建立目錄
    for d in [STAGING_IMAGES, STAGING_LABELS, IMAGES_TRAIN, IMAGES_VAL, LABELS_TRAIN, LABELS_VAL]:
        d.mkdir(parents=True, exist_ok=True)

    # 載入模型
    print(f"\n載入模型...")
    model = YOLO(str(weights_path))

    # 已存在的檔案（用於跳過已標註的影片幀）
    existing = set()
    for d in [IMAGES_TRAIN, IMAGES_VAL]:
        existing.update(f.stem for f in d.glob("*.jpg"))

    total_saved = 0
    for i, video_path in enumerate(videos, 1):
        # 檢查這部影片是否已經被標註過
        prefix = video_path.stem
        already_done = sum(1 for s in existing if s.startswith(prefix))
        if already_done > 0:
            print(f"\n[{i}/{len(videos)}] {video_path.name} — 已有 {already_done} 張，跳過")
            continue

        print(f"\n[{i}/{len(videos)}] 處理 {video_path.name}...")
        n = process_video(
            video_path, model,
            stride=args.stride,
            conf=args.conf,
            imgsz=args.imgsz,
            out_images=STAGING_IMAGES,
            out_labels=STAGING_LABELS,
        )
        total_saved += n
        print(f"  -> 儲存 {n} 筆標註")

    print("\n" + "=" * 60)
    print(f"自動標註完成！新增 {total_saved} 筆標註")

    # 分割 train/val
    if total_saved > 0:
        split_train_val(STAGING_IMAGES, STAGING_LABELS, args.val_ratio)

    # 最終統計
    n_train = len(list(IMAGES_TRAIN.glob("*.jpg")))
    n_val = len(list(IMAGES_VAL.glob("*.jpg")))
    print(f"\n最終資料集統計：")
    print(f"  Train: {n_train} 張")
    print(f"  Val:   {n_val} 張")
    print(f"  合計:  {n_train + n_val} 張")

    # 清理 cache 檔
    for cache in DATASET_ROOT.rglob("*.cache"):
        cache.unlink()
        print(f"  已刪除快取：{cache.name}")

    print("\n完成！可執行 python train_yolo11.py 開始訓練。")


if __name__ == "__main__":
    main()
