from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import cv2

# ── 路徑 ──────────────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parents[1]
YOLOV8_DIR = Path(__file__).resolve().parent
VIDEOS_DIR = ROOT / "videos"
DATASET_ROOT = YOLOV8_DIR / "datasets" / "baseball"
STAGING_IMAGES = DATASET_ROOT / "images" / "_staging"
STAGING_LABELS = DATASET_ROOT / "labels" / "_staging"
VIDEO_EXTS = {".mp4", ".avi", ".mov", ".mkv"}

# ── UI 設定 ───────────────────────────────────────────────────────────────────
WIN = "Baseball Labeling Tool  [drag=box  Enter=save  D=skip  A=back  Z=clear  Q=quit]"
BOX_COLOR   = (0, 255, 80)   # 確認框：綠色
DRAFT_COLOR = (0, 180, 255)  # 拖曳中：橙色
THICKNESS   = 2
DISP_MAX_W  = 1080           # 顯示視窗最大寬度（原圖縮放後顯示）
DISP_MAX_H  = 1920           # iPhone 直拍旋轉後高度可達 3700+，允許較高視窗


def _get_video_rotation(video_path: Path) -> int:
    """用 ffprobe 讀取影片的 display rotation（side data）。
    回傳需要套用的 cv2.ROTATE_* 常數，或 None 表示不需要旋轉。
    iPhone 直拍通常是 rotation=-90（需順時針轉90度）。
    """
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "quiet", "-show_streams", str(video_path)],
            stderr=subprocess.DEVNULL,
            text=True,
        )
        for line in out.splitlines():
            if "rotation=" in line:
                try:
                    angle = int(float(line.split("=")[1].strip()))
                except ValueError:
                    continue
                # ffprobe rotation 是「顯示時需要旋轉的角度」
                # rotation=-90 → 畫面需順時針轉90度才正確
                if angle == -90 or angle == 270:
                    return cv2.ROTATE_90_CLOCKWISE
                if angle == 90 or angle == -270:
                    return cv2.ROTATE_90_COUNTERCLOCKWISE
                if angle == 180 or angle == -180:
                    return cv2.ROTATE_180
    except Exception:
        pass
    return None


def collect_videos(videos_dir: Path) -> list[Path]:
    videos = []
    for f in sorted(videos_dir.rglob("*")):
        if f.is_file() and f.suffix.lower() in VIDEO_EXTS:
            videos.append(f)
    return videos


def load_progress(video_path: Path) -> dict:
    """載入該影片的標注進度（json 側車檔）。"""
    prog_file = STAGING_LABELS / f"_progress_{video_path.stem}.json"
    if prog_file.exists():
        try:
            return json.loads(prog_file.read_text())
        except Exception:
            pass
    return {"done_frames": [], "skip_frames": []}


def save_progress(video_path: Path, progress: dict):
    prog_file = STAGING_LABELS / f"_progress_{video_path.stem}.json"
    prog_file.write_text(json.dumps(progress))


def _parse_rotate_code(rotate_arg: str | None, video_path: Path):
    """依參數回傳 cv2 旋轉常數。rotate_arg: auto|none|90|-90|180"""
    if rotate_arg == "none" or rotate_arg is None:
        return None
    if rotate_arg == "90":
        return cv2.ROTATE_90_CLOCKWISE
    if rotate_arg == "-90":
        return cv2.ROTATE_90_COUNTERCLOCKWISE
    if rotate_arg == "180":
        return cv2.ROTATE_180
    # auto：依影片 metadata 偵測
    return _get_video_rotation(video_path)


def label_video(video_path: Path, stride: int, start_frame: int, end_frame: int | None, rotate_override: str = "auto"):
    """開啟視窗讓使用者手動標注單一影片。rotate_override: auto|none|90|-90|180"""
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        print(f"  [錯誤] 無法開啟影片：{video_path}")
        return

    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps          = cap.get(cv2.CAP_PROP_FPS) or 30
    width        = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height       = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    if end_frame is None:
        end_frame = total_frames - 1

    # 旋轉：可強制指定方向或關閉（方向不對時請用 --rotate 修正）
    rotate_code = _parse_rotate_code(rotate_override, video_path)
    if rotate_code is not None:
        # 旋轉後寬高互換
        if rotate_code in (cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE):
            orig_w, orig_h = height, width   # 旋轉後的實際寬高
        else:
            orig_w, orig_h = width, height
        print(f"   旋轉：{rotate_override} → 轉正後尺寸 {orig_w}×{orig_h}")
    else:
        orig_w, orig_h = width, height

    # 顯示縮放比例（以轉正後的尺寸計算）
    scale = min(DISP_MAX_W / orig_w, DISP_MAX_H / orig_h, 1.0)
    disp_w = int(orig_w * scale)
    disp_h = int(orig_h * scale)

    print(f"\n▶  {video_path.name}  ({width}×{height}, {fps:.0f}fps, {total_frames}幀)")
    print(f"   顯示尺寸：{disp_w}×{disp_h}，縮放比例 {scale:.3f}")

    # 載入已有進度
    progress = load_progress(video_path)
    done_set = set(progress.get("done_frames", []))
    skip_set = set(progress.get("skip_frames", []))

    # 建立候選幀列表（依 stride）
    candidate_frames = [
        i for i in range(start_frame, end_frame + 1, stride)
        if i not in done_set and i not in skip_set
    ]
    # 已完成的幀也加進去（支援回退）
    all_frames = sorted(set(
        range(start_frame, end_frame + 1, stride)
    ))

    if not candidate_frames:
        print("   此影片所有幀均已標注，跳過。")
        cap.release()
        return

    print(f"   待標注幀數：{len(candidate_frames)}（已完成 {len(done_set)}，已跳過 {len(skip_set)}）")
    print("   ─────────────────────────────────────────────────")

    # ── 滑鼠回調 ──────────────────────────────────────────────────────────────
    drawing   = False
    box_start = None    # 拖曳起點（顯示座標）
    box_end   = None    # 拖曳終點（顯示座標）
    confirmed_box = None  # 已確認的框（顯示座標）
    current_frame_img = None  # 當前 frame 的 BGR 圖

    def on_mouse(event, x, y, flags, param):
        nonlocal drawing, box_start, box_end, confirmed_box

        if event == cv2.EVENT_LBUTTONDOWN:
            drawing   = True
            box_start = (x, y)
            box_end   = (x, y)

        elif event == cv2.EVENT_MOUSEMOVE and drawing:
            box_end = (x, y)

        elif event == cv2.EVENT_LBUTTONUP:
            drawing   = False
            box_end   = (x, y)
            # 過小的框忽略
            if abs(box_end[0] - box_start[0]) > 5 and abs(box_end[1] - box_start[1]) > 5:
                confirmed_box = (box_start, box_end)
            else:
                box_start = None
                box_end   = None

    cv2.namedWindow(WIN, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(WIN, disp_w, disp_h + 50)
    cv2.setMouseCallback(WIN, on_mouse)

    # ── 主迴圈 ────────────────────────────────────────────────────────────────
    idx_in_all = 0
    # 找到第一個還沒做的 frame
    for ii, fi in enumerate(all_frames):
        if fi not in done_set and fi not in skip_set:
            idx_in_all = ii
            break

    saved_count = 0

    while True:
        if idx_in_all < 0:
            idx_in_all = 0
        if idx_in_all >= len(all_frames):
            print("   ✅ 此影片所有幀已標注完畢！")
            break

        frame_idx = all_frames[idx_in_all]

        # 讀取幀
        cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
        ok, frame = cap.read()
        if not ok:
            idx_in_all += 1
            continue

        # 套用旋轉（iPhone 直拍需要順時針轉90度）
        if rotate_code is not None:
            frame = cv2.rotate(frame, rotate_code)

        current_frame_img = cv2.resize(frame, (disp_w, disp_h))

        # 若已標注過，還原其框（供回退時顯示）
        if frame_idx in done_set:
            lbl_path = STAGING_LABELS / f"{video_path.stem}_{frame_idx:06d}.txt"
            if lbl_path.exists():
                line = lbl_path.read_text().strip().split()
                if len(line) == 5:
                    _, cx_n, cy_n, w_n, h_n = map(float, line)
                    x1d = int((cx_n - w_n / 2) * disp_w)
                    y1d = int((cy_n - h_n / 2) * disp_h)
                    x2d = int((cx_n + w_n / 2) * disp_w)
                    y2d = int((cy_n + h_n / 2) * disp_h)
                    confirmed_box = ((x1d, y1d), (x2d, y2d))
        elif frame_idx in skip_set:
            confirmed_box = None
        else:
            confirmed_box = None

        # 重設拖曳狀態
        box_start = None
        box_end   = None
        drawing   = False

        # ── 顯示迴圈（直到使用者按鍵）──────────────────────────────────────
        while True:
            disp = current_frame_img.copy()

            # 右上角狀態文字
            status_already = "✓ labeled" if frame_idx in done_set else ("— skipped" if frame_idx in skip_set else "pending")
            label_text = (f"Frame {frame_idx}/{end_frame}  |  {idx_in_all + 1}/{len(all_frames)}  "
                          f"|  {status_already}  |  saved={saved_count}")
            cv2.rectangle(disp, (0, 0), (disp_w, 22), (30, 30, 30), -1)
            cv2.putText(disp, label_text, (6, 15),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.45, (220, 220, 220), 1, cv2.LINE_AA)

            # 確認框（綠）
            if confirmed_box:
                cv2.rectangle(disp, confirmed_box[0], confirmed_box[1], BOX_COLOR, THICKNESS)
                # 顯示 bbox 尺寸
                bw = abs(confirmed_box[1][0] - confirmed_box[0][0])
                bh = abs(confirmed_box[1][1] - confirmed_box[0][1])
                cv2.putText(disp, f"{bw}x{bh}px", (confirmed_box[0][0], confirmed_box[0][1] - 4),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.4, BOX_COLOR, 1, cv2.LINE_AA)

            # 拖曳框（橙）
            if drawing and box_start and box_end:
                cv2.rectangle(disp, box_start, box_end, DRAFT_COLOR, THICKNESS)

            cv2.imshow(WIN, disp)
            key = cv2.waitKey(20) & 0xFF

            # ─ 確認此幀（Enter 或 Space）
            if key in (13, 32):  # Enter or Space
                if confirmed_box:
                    _save_label(video_path, frame_idx, confirmed_box, disp_w, disp_h, orig_w, orig_h, frame)
                    done_set.add(frame_idx)
                    skip_set.discard(frame_idx)
                    saved_count += 1
                    print(f"   ✓ 第 {frame_idx} 幀：已標注並儲存 (total {saved_count})")
                else:
                    print(f"   ⚠  第 {frame_idx} 幀：請先框選球再按 Enter，或按 D 跳過")
                    continue
                idx_in_all += 1
                break

            # ─ 跳過（D 或 →）
            elif key in (ord('d'), ord('D'), 83):  # d / right arrow
                skip_set.add(frame_idx)
                done_set.discard(frame_idx)
                print(f"   ↷ 第 {frame_idx} 幀：跳過（無球）")
                idx_in_all += 1
                break

            # ─ 上一幀（A 或 ←）
            elif key in (ord('a'), ord('A'), 81):  # a / left arrow
                idx_in_all = max(0, idx_in_all - 1)
                break

            # ─ 清除當前框（Z）
            elif key in (ord('z'), ord('Z')):
                confirmed_box = None
                box_start = None
                box_end   = None

            # ─ 離開（Q 或 Esc）
            elif key in (ord('q'), ord('Q'), 27):
                print(f"\n   已儲存 {saved_count} 筆標注，進度已記錄，下次繼續。")
                _flush_progress(video_path, done_set, skip_set)
                cap.release()
                cv2.destroyAllWindows()
                return

            # ─ 視窗關閉
            if cv2.getWindowProperty(WIN, cv2.WND_PROP_VISIBLE) < 1:
                print(f"\n   視窗已關閉。儲存 {saved_count} 筆。")
                _flush_progress(video_path, done_set, skip_set)
                cap.release()
                return

        # 每步都刷新進度
        _flush_progress(video_path, done_set, skip_set)

    cap.release()
    cv2.destroyAllWindows()
    print(f"\n   ✅ 完成！本次共儲存 {saved_count} 筆標注。")
    _flush_progress(video_path, done_set, skip_set)


def _save_label(video_path: Path, frame_idx: int,
                confirmed_box, disp_w: int, disp_h: int,
                orig_w: int, orig_h: int, orig_frame):
    """
    將標注框（顯示座標）轉換為 YOLO 歸一化格式後寫入檔案，
    同時把原始解析度的幀圖存為 JPEG。
    """
    (x1d, y1d), (x2d, y2d) = confirmed_box
    x1d, x2d = min(x1d, x2d), max(x1d, x2d)
    y1d, y2d = min(y1d, y2d), max(y1d, y2d)

    # 轉換為原始解析度座標
    scale_x = orig_w / disp_w
    scale_y = orig_h / disp_h
    x1o = x1d * scale_x
    y1o = y1d * scale_y
    x2o = x2d * scale_x
    y2o = y2d * scale_y

    # YOLO 歸一化格式
    cx_n = ((x1o + x2o) / 2.0) / orig_w
    cy_n = ((y1o + y2o) / 2.0) / orig_h
    w_n  = (x2o - x1o) / orig_w
    h_n  = (y2o - y1o) / orig_h

    # 邊界 clamp
    cx_n = max(0.0, min(1.0, cx_n))
    cy_n = max(0.0, min(1.0, cy_n))
    w_n  = max(1e-4, min(1.0, w_n))
    h_n  = max(1e-4, min(1.0, h_n))

    base_name = f"{video_path.stem}_{frame_idx:06d}"

    # 儲存圖片（原始解析度）
    img_path = STAGING_IMAGES / f"{base_name}.jpg"
    cv2.imwrite(str(img_path), orig_frame, [cv2.IMWRITE_JPEG_QUALITY, 95])

    # 儲存 YOLO label
    lbl_path = STAGING_LABELS / f"{base_name}.txt"
    lbl_path.write_text(f"0 {cx_n:.6f} {cy_n:.6f} {w_n:.6f} {h_n:.6f}\n")


def _flush_progress(video_path: Path, done_set: set, skip_set: set):
    save_progress(video_path, {
        "done_frames":  sorted(done_set),
        "skip_frames": sorted(skip_set),
    })


def _save_label_stem(
    stem: str,
    confirmed_box,
    disp_w: int,
    disp_h: int,
    orig_w: int,
    orig_h: int,
):
    """將標注寫入既有 staging 圖檔（依檔名 stem，不另存新圖）。"""
    (x1d, y1d), (x2d, y2d) = confirmed_box
    x1d, x2d = min(x1d, x2d), max(x1d, x2d)
    y1d, y2d = min(y1d, y2d), max(y1d, y2d)

    scale_x = orig_w / disp_w
    scale_y = orig_h / disp_h
    x1o = x1d * scale_x
    y1o = y1d * scale_y
    x2o = x2d * scale_x
    y2o = y2d * scale_y

    cx_n = ((x1o + x2o) / 2.0) / orig_w
    cy_n = ((y1o + y2o) / 2.0) / orig_h
    w_n = (x2o - x1o) / orig_w
    h_n = (y2o - y1o) / orig_h

    cx_n = max(0.0, min(1.0, cx_n))
    cy_n = max(0.0, min(1.0, cy_n))
    w_n = max(1e-4, min(1.0, w_n))
    h_n = max(1e-4, min(1.0, h_n))

    lbl_path = STAGING_LABELS / f"{stem}.txt"
    lbl_path.write_text(f"0 {cx_n:.6f} {cy_n:.6f} {w_n:.6f} {h_n:.6f}\n")


def label_staging_images(only_missing: bool):
    """直接對 images/_staging 內的 JPG 標注（無影片時使用）。only_missing：僅處理尚無 .txt 的圖。"""
    STAGING_IMAGES.mkdir(parents=True, exist_ok=True)
    STAGING_LABELS.mkdir(parents=True, exist_ok=True)

    all_jpgs = sorted(STAGING_IMAGES.glob("*.jpg"))
    if not all_jpgs:
        print(f"📂 {STAGING_IMAGES} 內沒有任何 .jpg。")
        return

    if only_missing:
        targets = [p for p in all_jpgs if not (STAGING_LABELS / f"{p.stem}.txt").exists()]
    else:
        targets = list(all_jpgs)

    if not targets:
        if only_missing:
            print("✅ _staging 內所有圖片都已有對應 .txt，沒有待標注項目。")
            print("   若要覆寫重標，請使用：python manual_label.py --staging --restage-all")
        else:
            print("沒有可處理的圖片。")
        return

    print(f"\n▶  Staging 圖片標注：{len(targets)} 張（only_missing={only_missing}）")
    print("   拖曳框選球 → Enter 儲存  |  D 跳過  |  A 上一張  |  Z 清除  |  Q 離開")

    drawing = False
    box_start = None
    box_end = None
    confirmed_box = None
    current_frame_img = None
    orig_h = orig_w = 0
    disp_w = disp_h = 0

    def on_mouse(event, x, y, flags, param):
        nonlocal drawing, box_start, box_end, confirmed_box

        if event == cv2.EVENT_LBUTTONDOWN:
            drawing = True
            box_start = (x, y)
            box_end = (x, y)
        elif event == cv2.EVENT_MOUSEMOVE and drawing:
            box_end = (x, y)
        elif event == cv2.EVENT_LBUTTONUP:
            drawing = False
            box_end = (x, y)
            if abs(box_end[0] - box_start[0]) > 5 and abs(box_end[1] - box_start[1]) > 5:
                confirmed_box = (box_start, box_end)
            else:
                box_start = None
                box_end = None

    cv2.namedWindow(WIN, cv2.WINDOW_NORMAL)

    idx = 0
    saved_count = 0

    while 0 <= idx < len(targets):
        img_path = targets[idx]
        stem = img_path.stem
        frame = cv2.imread(str(img_path))
        if frame is None:
            print(f"   [略過] 無法讀取：{img_path.name}")
            idx += 1
            continue

        orig_h, orig_w = frame.shape[:2]
        scale = min(DISP_MAX_W / orig_w, DISP_MAX_H / orig_h, 1.0)
        disp_w = int(orig_w * scale)
        disp_h = int(orig_h * scale)
        cv2.resizeWindow(WIN, disp_w, disp_h + 50)

        has_lbl = (STAGING_LABELS / f"{stem}.txt").exists()
        if has_lbl and not only_missing:
            line = (STAGING_LABELS / f"{stem}.txt").read_text().strip().split()
            if len(line) == 5:
                _, cx_n, cy_n, w_n, h_n = map(float, line)
                x1d = int((cx_n - w_n / 2) * disp_w)
                y1d = int((cy_n - h_n / 2) * disp_h)
                x2d = int((cx_n + w_n / 2) * disp_w)
                y2d = int((cy_n + h_n / 2) * disp_h)
                confirmed_box = ((x1d, y1d), (x2d, y2d))
            else:
                confirmed_box = None
        else:
            confirmed_box = None

        box_start = None
        box_end = None
        drawing = False
        current_frame_img = cv2.resize(frame, (disp_w, disp_h))

        while True:
            disp = current_frame_img.copy()
            status = "pending" if not has_lbl else "will overwrite"
            label_text = (
                f"{img_path.name}  |  {idx + 1}/{len(targets)}  |  {status}  |  saved={saved_count}"
            )
            cv2.rectangle(disp, (0, 0), (disp_w, 22), (30, 30, 30), -1)
            cv2.putText(
                disp,
                label_text,
                (6, 15),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.45,
                (220, 220, 220),
                1,
                cv2.LINE_AA,
            )

            if confirmed_box:
                cv2.rectangle(disp, confirmed_box[0], confirmed_box[1], BOX_COLOR, THICKNESS)
                bw = abs(confirmed_box[1][0] - confirmed_box[0][0])
                bh = abs(confirmed_box[1][1] - confirmed_box[0][1])
                cv2.putText(
                    disp,
                    f"{bw}x{bh}px",
                    (confirmed_box[0][0], confirmed_box[0][1] - 4),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.4,
                    BOX_COLOR,
                    1,
                    cv2.LINE_AA,
                )

            if drawing and box_start and box_end:
                cv2.rectangle(disp, box_start, box_end, DRAFT_COLOR, THICKNESS)

            cv2.imshow(WIN, disp)
            key = cv2.waitKey(20) & 0xFF

            if key in (13, 32):
                if confirmed_box:
                    _save_label_stem(stem, confirmed_box, disp_w, disp_h, orig_w, orig_h)
                    saved_count += 1
                    print(f"   ✓ {img_path.name}：已儲存 (total {saved_count})")
                    idx += 1
                    break
                print(f"   ⚠  請先框選球再按 Enter，或按 D 跳過")
                continue

            elif key in (ord("d"), ord("D"), 83):
                print(f"   ↷ {img_path.name}：跳過")
                idx += 1
                break

            elif key in (ord("a"), ord("A"), 81):
                idx = max(0, idx - 1)
                break

            elif key in (ord("z"), ord("Z")):
                confirmed_box = None
                box_start = None
                box_end = None

            elif key in (ord("q"), ord("Q"), 27):
                print(f"\n   已儲存 {saved_count} 筆，下次可繼續。")
                cv2.destroyAllWindows()
                return

            if cv2.getWindowProperty(WIN, cv2.WND_PROP_VISIBLE) < 1:
                print(f"\n   視窗已關閉。已儲存 {saved_count} 筆。")
                cv2.destroyAllWindows()
                return

    cv2.destroyAllWindows()
    print(f"\n   ✅ Staging 標注結束，本次共儲存 {saved_count} 筆。")


def print_summary():
    """顯示目前 staging 資料集的統計。"""
    n_img = len(list(STAGING_IMAGES.glob("*.jpg")))
    n_lbl = len(list(STAGING_LABELS.glob("*.txt")))
    print(f"\n📊 Staging 資料集：{n_img} 張圖片，{n_lbl} 個標注檔（.txt）")


def main():
    parser = argparse.ArgumentParser(description="後方視角手動 YOLO 棒球標注工具")
    parser.add_argument("--staging", action="store_true",
                        help="直接標注 datasets/baseball/images/_staging 內的 JPG（無需影片）")
    parser.add_argument("--restage-all", action="store_true",
                        help="與 --staging 併用：重新標注 _staging 內全部圖片（覆寫既有 .txt）")
    parser.add_argument("--video", type=Path, default=None,
                        help="指定單一影片（不指定則依序處理 videos/ 下所有影片）")
    parser.add_argument("--videos-dir", type=Path, default=VIDEOS_DIR,
                        help=f"影片根目錄（預設：{VIDEOS_DIR}）")
    parser.add_argument("--stride", type=int, default=3,
                        help="每 N 幀顯示一張（預設 3；120fps → 約 40fps 取樣）")
    parser.add_argument("--start", type=int, default=0,
                        help="起始幀（預設 0）")
    parser.add_argument("--end",   type=int, default=None,
                        help="結束幀（預設：影片末端）")
    parser.add_argument("--summary", action="store_true",
                        help="只顯示 staging 資料集統計，不開啟標注視窗")
    parser.add_argument("--rotate", type=str, default="auto",
                        choices=["auto", "none", "90", "-90", "180"],
                        help="畫面旋轉：auto=依影片 metadata，none=不旋轉，90/-90/180=強制順時針/逆時針 90° 或 180°（方向不對時可改此參數）")
    args = parser.parse_args()

    if args.summary:
        print_summary()
        return

    if args.staging:
        if args.restage_all:
            label_staging_images(only_missing=False)
        else:
            label_staging_images(only_missing=True)
        print_summary()
        print("\n標注完成後，執行以下指令分割資料並開始訓練：")
        print("  python batch_autolabel.py")
        print("  python train_yolo26.py")
        return

    # 建立輸出目錄
    STAGING_IMAGES.mkdir(parents=True, exist_ok=True)
    STAGING_LABELS.mkdir(parents=True, exist_ok=True)

    if args.video:
        videos = [args.video.resolve()]
    else:
        vdir = args.videos_dir
        if not vdir.is_absolute():
            vdir = vdir.resolve()
        videos = collect_videos(vdir)

    if not videos:
        print(f"找不到任何影片。請確認路徑：{args.videos_dir}", file=sys.stderr)
        sys.exit(1)

    print(f"找到 {len(videos)} 部影片")
    for p in videos:
        print(f"  • {p.name}")

    for i, vp in enumerate(videos, 1):
        print(f"\n{'='*60}")
        print(f"[{i}/{len(videos)}] {vp.name}")
        print(f"  按 Q 可中途離開（進度自動儲存）")
        label_video(vp, stride=args.stride, start_frame=args.start, end_frame=args.end, rotate_override=args.rotate)

    print("\n" + "="*60)
    print_summary()
    print("\n標注完成後，執行以下指令分割資料並開始訓練：")
    print("  python batch_autolabel.py  # 僅分割 train/val（已有手動標注，跳過自動標注）")
    print("  python train_yolo26.py     # 開始訓練（YOLO26n）")


if __name__ == "__main__":
    main()
