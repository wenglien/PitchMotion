from __future__ import annotations

import logging
import cv2
import mediapipe as mp
import numpy as np
from ultralytics import YOLO
from typing import Optional

from src.FrameInfo import FrameInfo
from src.utils import fill_lost_tracking
from src.ball_speed_calculator import BallSpeedCalculator
from src.release_point_detector import ReleasePointDetector
from src.SORT_tracker.sort import Sort

log = logging.getLogger(__name__)

mp_pose = mp.solutions.pose
mp_drawing = mp.solutions.drawing_utils


def _kmh_to_mph(kmh: float) -> Optional[float]:
    """Convert km/h to mph."""
    return kmh * 0.621371 if kmh else None


# ── Stride correction constants ─────────────────────────────────
BODY_STRIDE_DEFAULT_M = 1.2     # 身體前移（腿跨步），固定近似值
FOREARM_LENGTH_M = 0.45         # 前臂平均長度（肘到指尖）
MIN_FOREARM_PIXELS = 15         # 前臂像素長度（太短 = Pose 不可靠）


def _estimate_arm_forward_from_pose(
    pose_landmarks,
    throwing_hand: Optional[dict],
    ball_direction: Optional[tuple[float, float]],
    image_w: int,
    image_h: int,
) -> Optional[float]:
    """用像素估算手臂前伸距離（公尺）。

    1. 取投球手的肘和指尖像素座標
    2. 前臂向量投影到球飛行方向（若無球方向則用肘→指尖的水平分量）
    3. 投影長度 / 前臂像素總長 × 真實前臂長度 = 前伸公尺數

    不需要 pixels_per_meter，因為前臂自身就是比例尺。
    """
    if pose_landmarks is None or throwing_hand is None:
        return None

    elbow_idx = int(throwing_hand["elbow"])
    finger_idx = int(throwing_hand["index_finger"])

    try:
        elbow_lm = pose_landmarks.landmark[elbow_idx]
        finger_lm = pose_landmarks.landmark[finger_idx]
    except (IndexError, AttributeError):
        return None

    elbow_vis = elbow_lm.visibility if hasattr(elbow_lm, "visibility") else 0.0
    finger_vis = finger_lm.visibility if hasattr(finger_lm, "visibility") else 0.0
    if elbow_vis < 0.4 or finger_vis < 0.4:
        return None

    ex, ey = elbow_lm.x * image_w, elbow_lm.y * image_h
    fx, fy = finger_lm.x * image_w, finger_lm.y * image_h

    forearm_dx = fx - ex
    forearm_dy = fy - ey
    forearm_pixels = float(np.hypot(forearm_dx, forearm_dy))

    if forearm_pixels < MIN_FOREARM_PIXELS:
        return None

    if ball_direction is not None:
        bx, by = ball_direction
        b_len = float(np.hypot(bx, by))
        if b_len > 0:
            bx_n, by_n = bx / b_len, by / b_len
            projected = forearm_dx * bx_n + forearm_dy * by_n
            forward_ratio = abs(projected) / forearm_pixels
        else:
            forward_ratio = abs(forearm_dx) / forearm_pixels
    else:
        forward_ratio = abs(forearm_dx) / forearm_pixels

    forward_ratio = min(forward_ratio, 1.0)
    arm_forward_m = forward_ratio * FOREARM_LENGTH_M
    return arm_forward_m


def _estimate_stride_correction(
    pose_landmarks,
    throwing_hand: Optional[dict],
    ball_direction: Optional[tuple[float, float]],
    image_w: int,
    image_h: int,
) -> Optional[float]:
    """估算完整的 stride correction（身體前移 + 手臂前伸）。

    回傳 None 表示 Pose 資料不足，應使用預設值。
    """
    arm_forward = _estimate_arm_forward_from_pose(
        pose_landmarks, throwing_hand, ball_direction, image_w, image_h,
    )
    if arm_forward is None:
        return None

    correction = BODY_STRIDE_DEFAULT_M + arm_forward
    log.info(
        "Dynamic stride correction: body=%.2fm + arm=%.2fm = %.2fm",
        BODY_STRIDE_DEFAULT_M, arm_forward, correction,
    )
    return correction


# ── Release point pose validation ──────────────────────────────
MIN_ELBOW_ANGLE_AT_RELEASE = 130     # 出手時肘角度應 > 130°
MAX_RELEASE_BALL_DIST_RATIO = 0.20   # 出手點和第一顆球距離 ≤ 畫面對角線 20%


def _validate_release_point_with_pose(
    pose_landmarks,
    release_point: tuple[int, int],
    throwing_hand: Optional[dict],
    first_ball_point: Optional[tuple[int, int]],
    image_w: int,
    image_h: int,
) -> tuple[bool, list[str]]:
    """用 Pose 驗證出球點是否合理。

    回傳 (is_valid, reasons)：
    - is_valid: True 表示通過全部檢查
    - reasons: 失敗原因列表（用於 log）
    """
    if pose_landmarks is None or throwing_hand is None:
        return True, []  # 沒有 Pose 就不驗證，預設通過

    fails: list[str] = []

    def _get_pt(idx: int, min_vis: float = 0.3) -> Optional[tuple[float, float]]:
        try:
            lm = pose_landmarks.landmark[idx]
        except (IndexError, AttributeError):
            return None
        vis = lm.visibility if hasattr(lm, "visibility") else 1.0
        if vis < min_vis:
            return None
        return (lm.x * image_w, lm.y * image_h)

    shoulder = _get_pt(int(throwing_hand["shoulder"]))
    elbow = _get_pt(int(throwing_hand["elbow"]))
    wrist = _get_pt(int(throwing_hand["wrist"]))

    # ── checkpoint 1：手在腰部以上 ──
    # 用肩膀和髖關節推算腰部 y 座標
    hip_left = _get_pt(23)
    hip_right = _get_pt(24)
    if wrist is not None and (hip_left or hip_right):
        hip_y_vals = [p[1] for p in [hip_left, hip_right] if p is not None]
        hip_y = float(np.mean(hip_y_vals))
        if release_point[1] > hip_y + image_h * 0.05:
            fails.append(f"hand below waist (release_y={release_point[1]:.0f}, hip_y={hip_y:.0f})")

    # ── checkpoint 2：肘接近伸直（> 130°）──
    if shoulder is not None and elbow is not None and wrist is not None:
        v1 = np.array([shoulder[0] - elbow[0], shoulder[1] - elbow[1]])
        v2 = np.array([wrist[0] - elbow[0], wrist[1] - elbow[1]])
        cos_a = float(np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-6))
        cos_a = float(np.clip(cos_a, -1.0, 1.0))
        angle = float(np.arccos(cos_a) * 180 / np.pi)
        if angle < MIN_ELBOW_ANGLE_AT_RELEASE:
            fails.append(f"elbow not extended (angle={angle:.0f}°, need>{MIN_ELBOW_ANGLE_AT_RELEASE}°)")

    # ── checkpoint 3：出手點離第一顆球不太遠 ──
    if first_ball_point is not None:
        diag = float(np.hypot(image_w, image_h))
        dist = float(np.hypot(
            release_point[0] - first_ball_point[0],
            release_point[1] - first_ball_point[1],
        ))
        if dist > diag * MAX_RELEASE_BALL_DIST_RATIO:
            fails.append(
                f"release too far from first ball "
                f"(dist={dist:.0f}px, max={diag * MAX_RELEASE_BALL_DIST_RATIO:.0f}px)"
            )

    is_valid = len(fails) == 0
    return is_valid, fails


# ── Detection filter constants ─────────────────────────────────
MAX_AREA_RATIO = 0.005        # Max 0.5% of frame area
MIN_SIDE_RATIO = 0.002        # Min side length ratio
MAX_SIDE_RATIO = 0.05         # Max single side ratio
MAX_ASPECT_RATIO = 2.5        # Ball should be roughly square
BOTTOM_EXCLUDE_RATIO = 0.95   # Exclude bottom 5%
ANKLE_RADIUS_RATIO = 0.03     # Ankle exclusion zone
MIN_DISPLACEMENT_RATIO = 0.02 # Min displacement for valid track (% of diagonal)


def _names_to_map(names) -> dict[int, str]:
    if names is None:
        return {}
    if isinstance(names, dict):
        return {int(k): str(v) for k, v in names.items()}
    if isinstance(names, (list, tuple)):
        return {i: str(n) for i, n in enumerate(names)}
    return {}


def _infer_ball_class_ids(yolo_model: YOLO, first_result) -> Optional[set[int]]:
    """
    嘗試從 YOLO 類別名稱推斷「球」的 class id。
    若無法推斷（例如名稱不含 ball/baseball），回傳 None 表示不做 class 過濾。
    """
    names_map = {}
    if first_result is not None:
        names_map = _names_to_map(getattr(first_result, "names", None))
    if not names_map:
        names_map = _names_to_map(getattr(yolo_model, "names", None))

    if not names_map:
        return None

    if len(names_map) == 1:
        return set(names_map.keys())

    keywords = ("baseball", "ball")
    ball_ids = {cid for cid, name in names_map.items() if any(k in name.lower() for k in keywords)}
    return ball_ids or None


def _extract_ankles(pose_landmarks, width: int, height: int) -> list[tuple[int, int]]:
    if pose_landmarks is None:
        return []
    ankle_pts = []
    for idx in (27, 28):  # left/right ankle
        lm = pose_landmarks.landmark[idx]
        vis = lm.visibility if hasattr(lm, "visibility") else 1.0
        if vis >= 0.5:
            ankle_pts.append((int(lm.x * width), int(lm.y * height)))
    return ankle_pts


def _extract_release_point_from_pose(
    pose_landmarks,
    *,
    image_w: int,
    image_h: int,
    throwing_hand: Optional[dict],
    first_ball_point: Optional[tuple[int, int]] = None,
) -> Optional[tuple[int, int]]:
    """
    從單幀 pose landmarks 擷取「出手點」(release point)。

    - 優先用投球手的食指指尖（較接近球離手位置）
    - 若指尖不可用，退回投球手手腕
    - 若投球手未知且有第一顆球位置，選離球最近的手指/手腕
    - 若投球手未知且無球位置，選可見度最高者
    """
    if pose_landmarks is None:
        return None

    def get_xy(idx: int, min_vis: float) -> Optional[tuple[int, int]]:
        try:
            lm = pose_landmarks.landmark[idx]
        except Exception:
            return None
        vis = lm.visibility if hasattr(lm, "visibility") else 1.0
        if vis < min_vis:
            return None
        return (int(lm.x * image_w), int(lm.y * image_h))

    def get_xy_with_vis(idx: int, min_vis: float) -> Optional[tuple[tuple[int, int], float]]:
        try:
            lm = pose_landmarks.landmark[idx]
        except Exception:
            return None
        vis = lm.visibility if hasattr(lm, "visibility") else 1.0
        if vis < min_vis:
            return None
        return ((int(lm.x * image_w), int(lm.y * image_h)), vis)

    def _dist_sq(a: tuple[int, int], b: tuple[int, int]) -> float:
        return float((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2)

    if throwing_hand:
        fp = get_xy(int(throwing_hand["index_finger"]), 0.5)
        if fp is not None:
            return fp
        wp = get_xy(int(throwing_hand["wrist"]), 0.35)
        if wp is not None:
            return wp
        return None

    # throwing hand unknown → 收集所有候選
    candidates: list[tuple[tuple[int, int], float]] = []  # (point, visibility)
    for idx in (19, 20):  # index fingers
        r = get_xy_with_vis(idx, 0.5)
        if r is not None:
            candidates.append(r)
    if not candidates:
        for idx in (15, 16):  # wrists
            r = get_xy_with_vis(idx, 0.35)
            if r is not None:
                candidates.append(r)

    if not candidates:
        return None

    if first_ball_point is not None:
        # 選離第一顆球最近的（出手點應在球飛行路徑的起始端）
        return min(candidates, key=lambda c: _dist_sq(c[0], first_ball_point))[0]

    # 無球參考時，選可見度最高的（比盲選 y 最小更穩）
    return max(candidates, key=lambda c: c[1])[0]


def _filter_candidate_dets(
    dets_with_cls: list[np.ndarray],
    *,
    width: int,
    height: int,
    ball_class_ids: Optional[set[int]],
    pose_landmarks,
) -> list[np.ndarray]:
    """
    det 格式: [x1, y1, x2, y2, conf, cls]
    """
    if not dets_with_cls:
        return []

    max_area = float(width * height) * MAX_AREA_RATIO
    min_side = max(3.0, min(width, height) * MIN_SIDE_RATIO)
    max_single_side = min(width, height) * MAX_SIDE_RATIO

    ankle_pts = _extract_ankles(pose_landmarks, width, height)
    ankle_radius = max(20.0, min(width, height) * ANKLE_RADIUS_RATIO)

    filtered: list[np.ndarray] = []
    for det in dets_with_cls:
        x1, y1, x2, y2, conf, cls_id = det.tolist()
        cls_id_int = int(cls_id) if cls_id is not None else -1

        if ball_class_ids is not None and cls_id_int not in ball_class_ids:
            continue

        bw = max(0.0, x2 - x1)
        bh = max(0.0, y2 - y1)
        # 單邊太大的一定不是球（避免把身體部位當球）
        if bw > max_single_side or bh > max_single_side:
            continue
        if bw < min_side or bh < min_side:
            continue

        area = bw * bh
        if area <= 0 or area > max_area:
            continue

        aspect = (bw / (bh + 1e-6)) if bh > 0 else 999.0
        aspect = max(aspect, 1.0 / (aspect + 1e-6))
        if aspect > MAX_ASPECT_RATIO:
            continue

        cx = (x1 + x2) / 2.0
        cy = (y1 + y2) / 2.0

        if cy > height * BOTTOM_EXCLUDE_RATIO:
            continue

        # 排除腳踝附近（常見誤判來源）
        if ankle_pts:
            near_ankle = False
            for ax, ay in ankle_pts:
                if (cx - ax) ** 2 + (cy - ay) ** 2 <= ankle_radius ** 2:
                    near_ankle = True
                    break
            if near_ankle:
                continue

        filtered.append(det)

    # 不退回原始偵測 — 如果全部被過濾表示這一幀確實沒有球
    return filtered


def _pick_best_track_id(
    tracks_by_id: dict[int, list[dict]],
    *,
    width: int,
    height: int,
    raw_detections: list[dict],
) -> Optional[int]:
    """
    從 SORT 產生的多條 track 中挑出最像「球」的那一條。
    主要依據：總位移、平均速度、長度、bbox 面積偏小、少出現在腳踝/底部區域。
    飛行中的球必須有顯著位移（≥畫面對角線 5%），靜止/緩慢物體會被排除。
    """
    if not tracks_by_id:
        return None

    diag = float(np.hypot(width, height))
    min_displacement = diag * MIN_DISPLACEMENT_RATIO

    best_id = None
    best_score = -1e18

    log.debug("Track selection: %d tracks, %dx%d, min_disp=%.0fpx", len(tracks_by_id), width, height, min_displacement)

    for tid, items in tracks_by_id.items():
        # 至少 3 次偵測才算有效 track
        if len(items) < 3:
            continue

        items_sorted = sorted(items, key=lambda x: x["frame_id"])
        pts = [(it["cx"], it["cy"], it["frame_id"], it["area"]) for it in items_sorted]

        # 速度（以 frame gap 正規化）
        speeds = []
        for i in range(1, len(pts)):
            x0, y0, f0, _ = pts[i - 1]
            x1, y1, f1, _ = pts[i]
            df = max(1, int(f1 - f0))
            dist = float(np.hypot(x1 - x0, y1 - y0))
            speeds.append(dist / df)
        avg_speed = float(np.mean(speeds)) if speeds else 0.0

        x_start, y_start, _, _ = pts[0]
        x_end, y_end, _, _ = pts[-1]
        displacement = float(np.hypot(x_end - x_start, y_end - y_start))
        avg_area = float(np.mean([p[3] for p in pts]))

        # 位置懲罰：底部/腳踝附近
        bottom_frac = float(np.mean([1.0 if p[1] > height * 0.9 else 0.0 for p in pts]))

        ankle_hits = 0
        ankle_total = 0
        ankle_radius = max(20.0, min(width, height) * 0.03)
        for p in pts:
            _, _, frame_id, _ = p
            if 0 <= frame_id < len(raw_detections):
                ankle_pts = raw_detections[frame_id].get("ankle_pts", [])
                if ankle_pts:
                    ankle_total += 1
                    cx = p[0]
                    cy = p[1]
                    if any((cx - ax) ** 2 + (cy - ay) ** 2 <= ankle_radius ** 2 for ax, ay in ankle_pts):
                        ankle_hits += 1
        ankle_frac = (ankle_hits / ankle_total) if ankle_total > 0 else 0.0

        # 位移不足的 track 直接跳過（靜止/微動物體不可能是飛行中的球）
        if displacement < min_displacement:
            log.debug("  Track %d: pts=%d, disp=%.1fpx (%.1f%%), speed=%.1f -> skip (low displacement)", tid, len(pts), displacement, displacement/diag*100, avg_speed)
            continue

        # 基礎分數：重度偏好「位移大、速度快」
        # displacement 用平方加權，確保靜止物體即使幀數多也無法超過飛行球
        score = (displacement ** 2.0) * (avg_speed + 1.0) * (len(pts) ** 0.5) / ((avg_area + 1.0) ** 0.25)

        # 懲罰項
        score *= (1.0 - 0.6 * min(bottom_frac, 1.0))
        score *= (1.0 - 0.8 * min(ankle_frac, 1.0))

        log.debug("  Track %d: pts=%d, disp=%.1fpx (%.1f%%), speed=%.1f, score=%.1f", tid, len(pts), displacement, displacement/diag*100, avg_speed, score)

        if score > best_score:
            best_score = score
            best_id = tid

    if best_id is not None:
        log.info("Selected Track %d (score=%.1f)", best_id, best_score)
    else:
        log.info("No valid track found (all below displacement threshold)")

    return best_id


def get_pitch_frames_yolov8(
    video_path: str,
    yolo_model: YOLO,
    conf_threshold: float = 0.15,
    show_preview: bool = False,
    speed_calculator: Optional[BallSpeedCalculator] = None,
) -> tuple[list[FrameInfo], int, int, int, dict]:
    """
    使用 YOLOv8 模型偵測棒球，配 Mediapipe Pose 追蹤，
    輸出與原本 get_pitch_frames 類似的 pitch_frames 結構。
    
    Args:
        video_path: 影片檔案路徑
        yolo_model: 已載入的 YOLOv8 模型
        conf_threshold: YOLOv8 閾值（預設 0.15，建議 0.1-0.3 之間）
        show_preview: 是否顯示即時預覽視窗
        speed_calculator: 球速計算器（可選，用於計算球速）
    
    Returns:
        tuple: (pitch_frames, width, height, fps, speed_info)
            - pitch_frames: FrameInfo 列表，包含每一 frame 的球位置資訊
            - width: 影片寬度
            - height: 影片高度
            - fps: 影片幀率
            - speed_info: 球速資訊字典
    """
    log.info("Video from: %s", video_path)
    # Use OpenCV to read the video information (width, height, FPS), the actual frame is read by YOLOv8 later
    meta_cap = cv2.VideoCapture(video_path)
    if not meta_cap.isOpened():
        raise ValueError(
            f"無法開啟影片檔案：{video_path}\n請確認檔案格式是否支援（mp4/avi/mov/mkv）。"
        )

    width = int(meta_cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(meta_cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = int(meta_cap.get(cv2.CAP_PROP_FPS))
    meta_cap.release()

    if width <= 0 or height <= 0:
        raise ValueError(
            f"無法讀取影片尺寸，可能是檔案損壞或格式不支援：{video_path}"
        )
    if fps <= 0:
        fps = 30
        log.warning("Cannot read fps, using default 30")

    pitch_frames: list[FrameInfo] = []
    raw_detections: list = []  # 儲存原始偵測結果（尚未修正出球點）
    frame_id = 0
    release_point = None  # 記錄出手點
    
    # 初始化多訊號出球點檢測器
    release_detector = ReleasePointDetector(fps=fps)
    ball_class_ids: Optional[set[int]] = None

    pose = mp_pose.Pose(
        static_image_mode=False,
        model_complexity=1,
        enable_segmentation=False,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )

    try:
        # Use the YOLOv8 video streaming interface, the same as the way you tested the video with CLI
        results_generator = yolo_model.predict(
            source=video_path,
            conf=conf_threshold,
            iou=0.3,
            imgsz=1280,
            stream=True,
            verbose=False,
        )
    except Exception as e:
        pose.close()
        raise RuntimeError(
            f"無法使用 YOLOv8 處理影片：{video_path}\n錯誤：{e}"
        ) from e

    first_result = None
    try:
        for result in results_generator:
            if first_result is None:
                first_result = result
                ball_class_ids = _infer_ball_class_ids(yolo_model, first_result)

            # The original image returned by YOLO is BGR
            frame_bgr = result.orig_img
            frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)

            # Mediapipe pose
            results = pose.process(frame_rgb)
            has_pose = results is not None and results.pose_landmarks is not None
            if has_pose:
                # 添加到出球點檢測器
                release_detector.add_frame(results.pose_landmarks, width, height)

                mp_drawing.draw_landmarks(
                    frame_rgb,
                    results.pose_landmarks,
                    mp_pose.POSE_CONNECTIONS,
                    mp_drawing.DrawingSpec(color=(0, 255, 0), thickness=2, circle_radius=2),
                    mp_drawing.DrawingSpec(color=(0, 0, 255), thickness=2, circle_radius=2),
                )
            else:
                # 沒有 pose，添加 None
                release_detector.add_frame(None, width, height)

            # Directly extract the detection box from the YOLO result
            # det format: [x1, y1, x2, y2, conf, cls]
            dets_with_cls: list[np.ndarray] = []
            for box in result.boxes:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                score = float(box.conf[0].item())
                cls_id = None
                if hasattr(box, "cls") and box.cls is not None:
                    try:
                        cls_id = int(box.cls[0].item())
                    except Exception:
                        cls_id = None
                dets_with_cls.append(
                    np.array(
                        [x1, y1, x2, y2, score, cls_id if cls_id is not None else -1],
                        dtype=float,
                    )
                )

            # 以球的 class / 尺寸 / 腳踝附近等條件做第一階段過濾（避免腳誤判）
            dets_filtered = _filter_candidate_dets(
                dets_with_cls,
                width=width,
                height=height,
                ball_class_ids=ball_class_ids,
                pose_landmarks=results.pose_landmarks if has_pose else None,
            )

            # 儲存原始偵測資料（第一階段：收集數據）
            raw_detections.append(
                {
                    "frame_rgb": frame_rgb,
                    "frame_id": frame_id,
                    "dets_list": dets_filtered,
                    "has_pose": has_pose,
                    "pose_landmarks": results.pose_landmarks if has_pose else None,
                    "ankle_pts": _extract_ankles(results.pose_landmarks, width, height) if has_pose else [],
                }
            )

            if show_preview:
                vis = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR)
                cv2.imshow("yolov8_result", vis)
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break

            frame_id += 1
    finally:
        # 避免 mediapipe 資源未釋放（長影片/多次執行時較容易累積）
        pose.close()
        if show_preview:
            try:
                cv2.destroyAllWindows()
            except Exception:
                pass

    log.info("Phase 1 complete: data collection (%d frames)", frame_id)
    
    # ===== 第二階段：執行多訊號檢測並生成軌跡 =====
    
    # 執行多訊號出球點檢測
    optimal_release_frame_idx = None
    release_detection = None
    throwing_hand = release_detector.infer_throwing_hand()
    release_pose_frame_idx = None

    # 找出第一個有球偵測的幀，用於交叉驗證 release point
    _first_ball_frame_for_validation = None
    for _rd in raw_detections:
        if _rd["dets_list"]:
            _first_ball_frame_for_validation = _rd["frame_id"]
            break

    if release_detector.frame_count >= 10:
        release_detection = release_detector.detect_release_point(
            first_ball_frame=_first_ball_frame_for_validation
        )
        
        if release_detection and release_detection['confidence'] > 0.3:
            optimal_release_frame_idx = release_detection['frame_idx']
            
            signals = release_detection['signals']
            log.info(
                "Release point detected: frame=%d, confidence=%.2f, "
                "S1(wrist)=%s, S2(elbow)=%s, S3(foot)=%s",
                optimal_release_frame_idx, release_detection['confidence'],
                signals['s1_wrist_speed'], signals['s2_elbow_extension'],
                signals['s3_foot_window'],
            )

    # 找到「最接近 optimal_release_frame_idx 且有 pose」的幀，
    # 讓出球點可以在「沒有球偵測」的出手幀也能被記錄（提升 release point 準確性）
    if optimal_release_frame_idx is not None and raw_detections:
        for delta in (0, -1, 1, -2, 2, -3, 3, -4, 4):
            idx = int(optimal_release_frame_idx + delta)
            if 0 <= idx < len(raw_detections) and raw_detections[idx].get("has_pose"):
                release_pose_frame_idx = idx
                break
    
    # 第二階段：使用檢測結果處理每一幀
    log.info("Phase 2: Applying release point detection")

    # 以 SORT 做多幀追蹤，避免單幀誤判（腳/地面）把軌跡拉走
    # min_hits 用 1：讓短暫/斷續的球軌跡也能形成 track
    sort_tracker = Sort(max_age=10, min_hits=1, iou_threshold=0.1)
    tracks_by_id: dict[int, list[dict]] = {}
    tracks_by_frame: dict[int, dict[int, tuple[int, int]]] = {}

    for frame_data in raw_detections:
        fid = frame_data["frame_id"]
        dets_list = frame_data["dets_list"]

        if dets_list:
            dets_np = np.array([d[:5] for d in dets_list], dtype=float)
            trackings = sort_tracker.update(dets_np)
        else:
            trackings = sort_tracker.update()

        if trackings is None or len(trackings) == 0:
            continue

        for t in trackings:
            x1, y1, x2, y2, tid = t.tolist()
            tid_int = int(tid)
            cx = int((x1 + x2) / 2)
            cy = int((y1 + y2) / 2)
            area = float(max(0.0, (x2 - x1)) * max(0.0, (y2 - y1)))

            tracks_by_id.setdefault(tid_int, []).append(
                {"frame_id": fid, "cx": cx, "cy": cy, "area": area}
            )
            tracks_by_frame.setdefault(fid, {})[tid_int] = (cx, cy)

    best_track_id = _pick_best_track_id(
        tracks_by_id, width=width, height=height, raw_detections=raw_detections
    )

    first_release_adjusted = False
    first_ball_frame_idx = None

    # Fallback：若追蹤無法挑出合理 track（例如影片很短/偵測很少），改用逐幀貪婪選點
    # 仍保留「尺寸/踝部排除」的 dets_list，因此比原本的「只挑最高分」穩定很多。
    last_point = None
    last_vel = None

    for frame_data in raw_detections:
        frame_rgb = frame_data["frame_rgb"]
        fid = frame_data["frame_id"]
        has_pose = frame_data["has_pose"]
        pose_landmarks = frame_data["pose_landmarks"]

        # 先嘗試用 pose 的出手幀記錄 release point（即使該幀沒有球偵測）
        if (
            not first_release_adjusted
            and release_pose_frame_idx is not None
            and fid == release_pose_frame_idx
            and has_pose
        ):
            image_h, image_w, _ = frame_rgb.shape
            # 用第一顆球的位置幫助選正確的手
            _fbp = None
            if _first_ball_frame_for_validation is not None:
                for _rd in raw_detections:
                    if _rd["frame_id"] == _first_ball_frame_for_validation and _rd["dets_list"]:
                        _d = _rd["dets_list"][0]
                        _fbp = (int((_d[0] + _d[2]) / 2), int((_d[1] + _d[3]) / 2))
                        break
            rp = _extract_release_point_from_pose(
                pose_landmarks, image_w=image_w, image_h=image_h,
                throwing_hand=throwing_hand, first_ball_point=_fbp,
            )
            if rp is not None:
                # Pose 驗證：檢查出手姿態是否合理
                rp_valid, rp_fails = _validate_release_point_with_pose(
                    pose_landmarks, rp, throwing_hand, _fbp, image_w, image_h,
                )
                if rp_valid:
                    release_point = rp
                    first_release_adjusted = True
                    log.info("Release point recorded from pose frame %d (validated)", fid)
                else:
                    log.warning(
                        "Release point at frame %d failed pose validation: %s — "
                        "will fallback to first ball detection",
                        fid, "; ".join(rp_fails),
                    )

        point = None
        if best_track_id is not None:
            point = tracks_by_frame.get(fid, {}).get(best_track_id)
        else:
            dets_list = frame_data["dets_list"]
            if dets_list:
                # 從過濾後候選中，優先挑「接近預測位置」者；沒有歷史時挑最高分
                cand_centers = []
                for d in dets_list:
                    x1, y1, x2, y2, conf, _ = d.tolist()
                    cx = int((x1 + x2) / 2)
                    cy = int((y1 + y2) / 2)
                    cand_centers.append((cx, cy, float(conf)))

                if last_point is None:
                    point = max(cand_centers, key=lambda c: c[2])[:2]
                else:
                    pred = last_point
                    if last_vel is not None:
                        pred = (int(last_point[0] + last_vel[0]), int(last_point[1] + last_vel[1]))

                    # 距離太離譜的直接不選（避免突然跳到腳）
                    max_jump = width * 0.25
                    best = None
                    best_cost = 1e18
                    for cx, cy, conf in cand_centers:
                        dist = float(np.hypot(cx - pred[0], cy - pred[1]))
                        if dist > max_jump:
                            continue
                        # cost: 距離為主，置信度為輔（越高越好）
                        cost = dist - (conf * 50.0)
                        if cost < best_cost:
                            best_cost = cost
                            best = (cx, cy)
                    point = best

        if point is None:
            pitch_frames.append(FrameInfo(frame_rgb, False))
            continue

        centerX, centerY = point

        # 更新 fallback 的速度估計（即便走 track 模式也可以讓後續更穩）
        if last_point is not None:
            last_vel = (centerX - last_point[0], centerY - last_point[1])
        last_point = (centerX, centerY)

        if first_ball_frame_idx is None:
            first_ball_frame_idx = fid

        # 若 pose 出手幀未成功記錄（例如 pose 缺失/信心不足），退回用「第一個球偵測點」記錄一次
        if not first_release_adjusted and fid == first_ball_frame_idx:
            if has_pose:
                image_h, image_w, _ = frame_rgb.shape
                rp = _extract_release_point_from_pose(
                    pose_landmarks, image_w=image_w, image_h=image_h,
                    throwing_hand=throwing_hand,
                    first_ball_point=(centerX, centerY),
                )
                release_point = rp if rp is not None else (centerX, centerY)
            else:
                release_point = (centerX, centerY)
            first_release_adjusted = True
            log.info("Using first ball detection as release point (frame %d)", fid)

        color = (255, 255, 0)
        pitch_frames.append(FrameInfo(frame_rgb, True, (centerX, centerY), color))

    # 計算球速
    speed_info = {}
    if speed_calculator and len(pitch_frames) > 0:
        # 提取所有有球的 frame 的座標
        ball_trajectory = [
            frame.ball for frame in pitch_frames 
            if frame.ball_in_frame
        ]
        
        # 若 pose 不可靠導致出球點退化成「第一顆球的位置」，用軌跡前段反推一個較合理的出球點
        # （主要用於 overlay 標記，避免出球點落在打者腳邊或畫面中段）
        if len(ball_trajectory) >= 2:
            p0 = ball_trajectory[0]
            p1 = ball_trajectory[1]
            vx = p1[0] - p0[0]
            vy = p1[1] - p0[1]
            # 速度太小通常代表誤判或幾乎沒動，不做反推
            if (vx * vx + vy * vy) >= 4:
                # 用實際幀差回推；若無出手幀資訊則以 FPS 估計
                if optimal_release_frame_idx is not None and first_ball_frame_idx is not None and first_ball_frame_idx > optimal_release_frame_idx:
                    frames_back = float(first_ball_frame_idx - optimal_release_frame_idx)
                else:
                    frames_back = max(1.0, round(0.067 * fps, 1))
                est_x = int(p0[0] - vx * frames_back)
                est_y = int(p0[1] - vy * frames_back)
                est_x = max(0, min(width - 1, est_x))
                est_y = max(0, min(height - 1, est_y))

                # 只有在 release_point 不存在或明顯是退化值（與第一點相同）時才覆蓋
                if release_point is None or release_point == p0:
                    release_point = (est_x, est_y)

        # 找出最後一個有球的 frame index
        last_ball_frame_idx = None
        for i in range(len(pitch_frames) - 1, -1, -1):
            if pitch_frames[i].ball_in_frame:
                last_ball_frame_idx = i
                break

        # 動態 stride correction：用 Pose 的前臂像素比例估算手臂前伸距離
        if len(ball_trajectory) >= 2:
            ball_dir = (
                float(ball_trajectory[1][0] - ball_trajectory[0][0]),
                float(ball_trajectory[1][1] - ball_trajectory[0][1]),
            )
        else:
            ball_dir = None

        release_pose_lm = None
        if release_pose_frame_idx is not None and 0 <= release_pose_frame_idx < len(raw_detections):
            release_pose_lm = raw_detections[release_pose_frame_idx].get("pose_landmarks")

        dynamic_stride = _estimate_stride_correction(
            release_pose_lm, throwing_hand, ball_dir, width, height,
        )
        if dynamic_stride is not None:
            speed_calculator.stride_correction = dynamic_stride
            log.info("Using dynamic stride correction: %.2fm", dynamic_stride)

        if len(ball_trajectory) >= 2:
            speed_info = speed_calculator.calculate_speed_detailed(
                ball_trajectory,
                release_point=release_point,
                release_frame_idx=optimal_release_frame_idx,
                first_ball_frame_idx=first_ball_frame_idx,
                last_ball_frame_idx=last_ball_frame_idx,
            )
            
            # 添加 release_point 到 speed_info 以便在 overlay 中繪製
            if release_point:
                speed_info['release_point'] = release_point
            
            # 添加 receive_point（接球點）到 speed_info 以便在 overlay 中繪製
            # receive_point 是軌跡的最後一個點（球到達捕手位置）
            # 確保取到最後的實際軌跡點，而非計算過程中的中間值
            if len(ball_trajectory) > 0:
                last_ball_point = ball_trajectory[-1]
                speed_info['receive_point'] = last_ball_point
                log.debug(f"receive_point set to ball_trajectory[-1]: {last_ball_point}")
        else:
            speed_info = {}
            
            # Log speed results
            if speed_info and not speed_info.get('error'):
                method = speed_info.get('calculation_method', 'unknown')
                parts = [f"method={method}"]
                for key, label in [
                    ('release_speed_kmh', 'release'),
                    ('initial_speed_kmh', 'initial'),
                    ('max_speed_kmh', 'max'),
                    ('average_speed_kmh', 'avg'),
                ]:
                    kmh = speed_info.get(key)
                    if kmh:
                        parts.append(f"{label}={kmh:.1f}km/h({_kmh_to_mph(kmh):.1f}mph)")
                if speed_info.get('total_distance_m'):
                    parts.append(f"dist={speed_info['total_distance_m']:.2f}m")
                if speed_info.get('num_frames'):
                    parts.append(f"frames={speed_info['num_frames']}")
                log.info("Speed results: %s", ", ".join(parts))

    # 補齊少量漏追蹤，讓軌跡更順（若點數不足則函式會直接略過）
    fill_lost_tracking(pitch_frames)

    return pitch_frames, width, height, fps, speed_info
