from __future__ import annotations

import logging
import os
import subprocess
import cv2
import mediapipe as mp
import numpy as np
from ultralytics import YOLO
from typing import Optional

from research.vision.utils import FrameInfo
from research.vision.utils import fill_lost_tracking, kmh_to_mph
from research.vision.ball_speed_calculator import BallSpeedCalculator
from research.vision.release_point_detector import ReleasePointDetector
from research.vision.SORT_tracker.sort import Sort

log = logging.getLogger(__name__)

mp_pose = mp.solutions.pose
mp_drawing = mp.solutions.drawing_utils


def _angle_to_rotate_code(angle: int) -> Optional[int]:
    """Convert a rotation angle (degrees) to an OpenCV rotate code."""
    angle = angle % 360
    if angle == 270 or angle == (360 - 90):          # -90 or 270
        return cv2.ROTATE_90_CLOCKWISE
    if angle == 90:
        return cv2.ROTATE_90_COUNTERCLOCKWISE
    if angle == 180:
        return cv2.ROTATE_180
    return None


def _get_video_rotation(video_path: str) -> Optional[int]:
    """Detect video rotation metadata.

    Supports three methods (tried in order):
      1. ffprobe JSON side_data_list → "Display Matrix" rotation  (ffprobe ≥5.0)
      2. ffprobe JSON stream tags → "rotate" tag                  (MOV/MP4 metadata)
      3. ffprobe text -show_streams → "rotation=" line            (ffprobe <5.0 legacy)
    """
    import json as _json

    # ── Method 1+2: JSON parsing (most reliable) ──────────────────────────
    try:
        out = subprocess.check_output(
            [
                "ffprobe", "-v", "quiet",
                "-print_format", "json",
                "-show_streams",
                video_path,
            ],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=15,
        )
        data = _json.loads(out)
        for stream in data.get("streams", []):
            if stream.get("codec_type") != "video":
                continue

            # Method 1: side_data_list → Display Matrix (ffprobe ≥5.0)
            for sd in stream.get("side_data_list", []):
                if "Display Matrix" in sd.get("side_data_type", ""):
                    rot = sd.get("rotation")
                    if rot is not None:
                        angle = int(float(rot))
                        code = _angle_to_rotate_code(angle)
                        if code is not None:
                            log.info("Rotation from displaymatrix: %d° → code=%s",
                                     angle, code)
                            return code

            # Method 2: stream tags → "rotate" (QuickTime/MOV metadata)
            tags = stream.get("tags", {})
            rotate_tag = tags.get("rotate") or tags.get("Rotate")
            if rotate_tag is not None:
                try:
                    angle = int(float(rotate_tag))
                    code = _angle_to_rotate_code(angle)
                    if code is not None:
                        log.info("Rotation from stream tag 'rotate': %d° → code=%s",
                                 angle, code)
                        return code
                except (ValueError, TypeError):
                    pass
    except Exception as exc:
        log.debug("ffprobe JSON rotation lookup failed: %s", exc)

    # ── Method 3: legacy text parsing (ffprobe <5.0 fallback) ─────────────
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "quiet", "-show_streams", video_path],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=15,
        )
        for line in out.splitlines():
            if "rotation=" in line:
                try:
                    angle = int(float(line.split("=")[1].strip()))
                except ValueError:
                    continue
                code = _angle_to_rotate_code(angle)
                if code is not None:
                    log.info("Rotation from legacy text: %d° → code=%s", angle, code)
                    return code
    except Exception:
        pass

    return None


def _get_raw_video_dims_ffprobe(video_path: str) -> tuple[int, int] | None:
    """Return the **coded** (stored) pixel dimensions via ffprobe.

    Prefers ``coded_width``/``coded_height`` which always reflect actual storage
    regardless of rotation metadata.  Falls back to ``width``/``height`` if the
    coded fields are absent (older containers).
    """
    import json as _json
    try:
        out = subprocess.check_output(
            [
                "ffprobe", "-v", "quiet",
                "-print_format", "json",
                "-show_streams",
                video_path,
            ],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=15,
        )
        data = _json.loads(out)
        for stream in data.get("streams", []):
            if stream.get("codec_type") == "video":
                # Prefer coded dimensions (always raw storage, ignores rotation)
                cw = stream.get("coded_width")
                ch = stream.get("coded_height")
                if cw and ch and int(cw) > 0 and int(ch) > 0:
                    return int(cw), int(ch)
                # Fallback: width/height (may include rotation in some ffprobe versions)
                w = stream.get("width")
                h = stream.get("height")
                if w and h and int(w) > 0 and int(h) > 0:
                    return int(w), int(h)
    except Exception as exc:
        log.debug("ffprobe stream dims lookup failed: %s", exc)
    return None


def _get_video_fps_ffprobe(video_path: str) -> float | None:
    """Use ffprobe avg_frame_rate for true playback fps.

    cv2.CAP_PROP_FPS returns r_frame_rate (e.g. 120 for a 120fps video),
    but variable-frame-rate iPhone videos recorded in slow-motion sometimes
    have avg_frame_rate ≈ 110, causing the output overlay to be 9% too fast.
    avg_frame_rate reflects the actual number of frames / duration.
    """
    import json as _json, fractions as _frac
    try:
        out = subprocess.check_output(
            [
                "ffprobe", "-v", "quiet",
                "-print_format", "json",
                "-show_streams",
                video_path,
            ],
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=15,
        )
        data = _json.loads(out)
        for stream in data.get("streams", []):
            if stream.get("codec_type") == "video":
                avg = stream.get("avg_frame_rate", "0/1")
                val = float(_frac.Fraction(avg))
                if val > 0:
                    return val
    except Exception as exc:
        log.debug("ffprobe fps lookup failed: %s", exc)
    return None


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
MIN_ELBOW_ANGLE_2D = 120             # 出手時肘角度（2D projection，容許透視壓縮）
MIN_ELBOW_ANGLE_3D = 100             # 出手時肘角度（3D world coords，MediaPipe 快速動作下易低估）
MAX_RELEASE_BALL_DIST_RATIO = 0.15   # 出手點和第一顆球距離 ≤ 畫面對角線 15%
RELEASE_TRAJ_DIST_RATIO = 0.08      # release point 和軌跡反推的最大偏差（對角線 8%）
RELEASE_DIR_MAX_ANGLE = 45.0        # release→first_ball 和球飛行方向最大偏差角度


def _validate_release_point_with_pose(
    pose_landmarks,
    release_point: tuple[int, int],
    throwing_hand: Optional[dict],
    first_ball_point: Optional[tuple[int, int]],
    image_w: int,
    image_h: int,
    pose_world_landmarks=None,
) -> tuple[bool, list[str]]:
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

    # ── checkpoint 2：肘接近伸直 ──
    # 優先使用 3D world landmarks（不受透視壓縮影響），否則 fallback 到 2D（放寬門檻）
    if shoulder is not None and elbow is not None and wrist is not None:
        used_3d = False
        if pose_world_landmarks is not None and throwing_hand is not None:
            try:
                s_w = pose_world_landmarks.landmark[int(throwing_hand["shoulder"])]
                e_w = pose_world_landmarks.landmark[int(throwing_hand["elbow"])]
                w_w = pose_world_landmarks.landmark[int(throwing_hand["wrist"])]
                v1 = np.array([s_w.x - e_w.x, s_w.y - e_w.y, s_w.z - e_w.z])
                v2 = np.array([w_w.x - e_w.x, w_w.y - e_w.y, w_w.z - e_w.z])
                cos_a = float(np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-6))
                cos_a = float(np.clip(cos_a, -1.0, 1.0))
                angle = float(np.arccos(cos_a) * 180 / np.pi)
                used_3d = True
                if angle < MIN_ELBOW_ANGLE_3D:
                    fails.append(f"elbow not extended (3D angle={angle:.0f}°, need>{MIN_ELBOW_ANGLE_3D}°)")
            except Exception:
                used_3d = False
        if not used_3d:
            v1 = np.array([shoulder[0] - elbow[0], shoulder[1] - elbow[1]])
            v2 = np.array([wrist[0] - elbow[0], wrist[1] - elbow[1]])
            cos_a = float(np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-6))
            cos_a = float(np.clip(cos_a, -1.0, 1.0))
            angle = float(np.arccos(cos_a) * 180 / np.pi)
            if angle < MIN_ELBOW_ANGLE_2D:
                fails.append(f"elbow not extended (2D angle={angle:.0f}°, need>{MIN_ELBOW_ANGLE_2D}°)")

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


ELBOW_SCAN_LOOKAHEAD = 20  # 往後掃描最多幀數（約 0.67s@30fps）


def _find_best_elbow_frame(
    raw_detections: list,
    start_fid: int,
    throwing_hand: Optional[dict],
    end_fid: Optional[int] = None,
    max_lookahead: int = ELBOW_SCAN_LOOKAHEAD,
) -> tuple[Optional[int], Optional[object], Optional[object], float]:
    """在 [start_fid, end_fid] 範圍內掃描，找 3D 手肘角最大的幀。

    Returns:
        (frame_id, pose_landmarks, pose_world_landmarks, best_angle)
    """
    if throwing_hand is None:
        return None, None, None, 0.0
    if end_fid is None:
        end_fid = start_fid + max_lookahead

    best_fid: Optional[int] = None
    best_angle = -1.0
    best_pose = None
    best_world = None

    for rd in raw_detections:
        fid = rd["frame_id"]
        if fid < start_fid or fid > end_fid:
            continue
        if not rd.get("has_pose"):
            continue
        wl = rd.get("pose_world_landmarks")
        if wl is None:
            continue
        try:
            s_w = wl.landmark[int(throwing_hand["shoulder"])]
            e_w = wl.landmark[int(throwing_hand["elbow"])]
            w_w = wl.landmark[int(throwing_hand["wrist"])]
            v1 = np.array([s_w.x - e_w.x, s_w.y - e_w.y, s_w.z - e_w.z])
            v2 = np.array([w_w.x - e_w.x, w_w.y - e_w.y, w_w.z - e_w.z])
            cos_a = float(np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-6))
            cos_a = float(np.clip(cos_a, -1.0, 1.0))
            angle = float(np.arccos(cos_a) * 180 / np.pi)
            if angle > best_angle:
                best_angle = angle
                best_fid = fid
                best_pose = rd["pose_landmarks"]
                best_world = wl
        except Exception:
            continue

    return best_fid, best_pose, best_world, best_angle


def _validate_release_against_trajectory(
    release_point: tuple[int, int],
    trajectory_estimate: tuple[int, int],
    first_ball_point: tuple[int, int],
    ball_direction: tuple[float, float],
    width: int,
    height: int,
) -> tuple[bool, list[str]]:
    """用球的飛行軌跡嚴格驗證 release point 是否合理

    1. 距離：release point 必須接近軌跡反推估計值（< 對角線 5%）
    2. 上游：release point 必須在第一顆球的「上游」（朝投手方向）
    3. 方向：release→first_ball 向量必須與球飛行方向大致一致（< 45°）

    Args:
        release_point: 待驗證的出手點
        trajectory_estimate: 軌跡反推的出手點估計
        first_ball_point: 第一顆球的偵測位置
        ball_direction: 球飛行方向向量 (dx, dy)（像素/幀）
        width, height: 畫面尺寸

    Returns:
        (is_valid, fail_reasons)
    """
    fails: list[str] = []
    diag = float(np.hypot(width, height))

    # ── Check 1：距離 ──
    dist = float(np.hypot(
        release_point[0] - trajectory_estimate[0],
        release_point[1] - trajectory_estimate[1],
    ))
    max_dist = diag * RELEASE_TRAJ_DIST_RATIO
    if dist > max_dist:
        fails.append(
            f"too far from trajectory estimate "
            f"(dist={dist:.0f}px, max={max_dist:.0f}px)"
        )

    # ── Check 2：上游（release 在第一顆球的飛行反方向側）──
    r2b_x = float(first_ball_point[0] - release_point[0])
    r2b_y = float(first_ball_point[1] - release_point[1])
    bd_x, bd_y = float(ball_direction[0]), float(ball_direction[1])
    dot = r2b_x * bd_x + r2b_y * bd_y
    if dot < 0:
        fails.append(
            f"downstream of first ball — release should be behind "
            f"(dot={dot:.0f}, expected > 0)"
        )

    # ── Check 3：方向一致性 ──
    r2b_len = float(np.hypot(r2b_x, r2b_y))
    bd_len = float(np.hypot(bd_x, bd_y))
    if r2b_len > 5.0 and bd_len > 0.1:
        cos_angle = dot / (r2b_len * bd_len)
        cos_angle = float(np.clip(cos_angle, -1.0, 1.0))
        angle = float(np.arccos(cos_angle) * 180.0 / np.pi)
        if angle > RELEASE_DIR_MAX_ANGLE:
            fails.append(
                f"direction mismatch with ball trajectory "
                f"(angle={angle:.0f}°, max={RELEASE_DIR_MAX_ANGLE:.0f}°)"
            )

    return len(fails) == 0, fails


# ── Detection filter constants ──
MAX_AREA_RATIO = 0.015   # 放寬：4K 近距手套+球約佔 0.8–1.2%，給 1.5% 餘裕
MIN_SIDE_RATIO = 0.002
MAX_SIDE_RATIO = 0.12    # 放寬：4K 2160px 的 12% = 259px，可容納近距手套+球
MAX_ASPECT_RATIO = 2.5
BOTTOM_EXCLUDE_RATIO = 0.97
TOP_EXCLUDE_RATIO = 0.20
ANKLE_RADIUS_RATIO = 0.03
MIN_DISPLACEMENT_RATIO = 0.005

# ── Catcher POV camera constants ──
SIZE_GROWTH_WEIGHT = 3.0
SIZE_SHRINK_PENALTY = 0.1

# ── Visual gap-fill constants ──
GAPFILL_ROI_CONF         = 0.03
GAPFILL_MAX_GAP_FRAMES   = 60
GAPFILL_ROI_BASE_HALF    = 100
GAPFILL_ROI_GROW_PER_FRM = 5
GAPFILL_AREA_LO_RATIO    = 0.25
GAPFILL_AREA_HI_RATIO    = 4.00
GAPFILL_CORRIDOR_RATIO   = 0.12

# ── Phase 1 即時 Kalman + ROI YOLO 追蹤常數 ──────────────────
# 在 Phase 1 每幀迴圈中，全幀 YOLO 沒命中時立即用 Kalman 預測 ROI 再做低 conf 推論
KALMAN_ROI_CONF          = 0.03   # Kalman-guided ROI 推論的信心門檻
KALMAN_ROI_BASE_HALF     = 80     # ROI 初始半徑（px）；比 Phase 1.5 小，因為是即時預測
KALMAN_ROI_GROW_PER_MISS = 10     # 每漏一幀 ROI 就擴大幾 px（Kalman 不確定性隨時間增長）
KALMAN_MAX_MISS          = 15     # 連續幾幀沒命中就宣告 lost（停止 ROI 推論）
KALMAN_AREA_LO_RATIO     = 0.20   # 接受的最小面積倍率
KALMAN_AREA_HI_RATIO     = 5.00   # 接受的最大面積倍率（球接近鏡頭時快速變大）

# Strike-zone normalised frame coordinates (catcher POV).
# MLB home plate width = 43.2 cm.  In portrait iPhone footage the catcher's
# body spans roughly 40-60% of frame width, so the plate (≈ shoulder-width)
# maps to about 30% of the frame width.  Vertically the zone covers knees to
# armpits, roughly 25-30% of frame height centred around 0.72-0.78.
STRIKE_ZONE_X_MIN = 0.33
STRIKE_ZONE_X_MAX = 0.67
STRIKE_ZONE_Y_MIN = 0.59
STRIKE_ZONE_Y_MAX = 0.83
ABS_STRIKE_ZONE_WIDTH_M = 0.4318  # 17 inches
ABS_STRIKE_ZONE_BOTTOM_RATIO = 0.27
ABS_STRIKE_ZONE_TOP_RATIO = 0.535
LEGACY_STRIKE_ZONE_HEIGHT_M = 0.58
ABS_STRIKE_ZONE_RULE = "MLB_ABS_2026"


def _clamp_float(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _median_or_none(values: list[float]) -> Optional[float]:
    vals = [float(v) for v in values if np.isfinite(v)]
    if not vals:
        return None
    return float(np.median(vals))


def _abs_strike_zone_height_m(batter_height_m: Optional[float]) -> Optional[float]:
    if batter_height_m is None or not np.isfinite(batter_height_m):
        return None
    if not 1.0 <= float(batter_height_m) <= 2.4:
        return None
    return float(batter_height_m) * (ABS_STRIKE_ZONE_TOP_RATIO - ABS_STRIKE_ZONE_BOTTOM_RATIO)


def _strike_zone_span_from_batter_height(
    batter_height_m: Optional[float],
) -> tuple[float, float, Optional[float]]:
    zone_w = STRIKE_ZONE_X_MAX - STRIKE_ZONE_X_MIN
    default_h = STRIKE_ZONE_Y_MAX - STRIKE_ZONE_Y_MIN
    zone_height_m = _abs_strike_zone_height_m(batter_height_m)
    if zone_height_m is None:
        return zone_w, default_h, None
    zone_h = default_h * (zone_height_m / LEGACY_STRIKE_ZONE_HEIGHT_M)
    return zone_w, _clamp_float(zone_h, 0.08, 0.45), zone_height_m


def _auto_calibrate_strike_zone(
    *,
    raw_detections: list[dict],
    track_points: list[dict],
    catch_pt: Optional[tuple[float, float]],
    width: int,
    height: int,
    zone_w: Optional[float] = None,
    zone_h: Optional[float] = None,
) -> Optional[dict]:
    """Estimate a per-video 2D strike zone for umpire/catcher POV footage.

    The estimate is anchored to the pitching lane, not the individual pitch:
    horizontal centre prefers pitcher pose centre (shoulders/hips), while the
    final trajectory only provides a weak fallback.  Vertical centre uses a
    damped correction from the final approach so one high/low pitch does not
    recenter the whole zone.
    """
    if width <= 0 or height <= 0:
        return None

    zone_w = zone_w if zone_w is not None else STRIKE_ZONE_X_MAX - STRIKE_ZONE_X_MIN
    zone_h = zone_h if zone_h is not None else STRIKE_ZONE_Y_MAX - STRIKE_ZONE_Y_MIN
    default_cx = (STRIKE_ZONE_X_MIN + STRIKE_ZONE_X_MAX) / 2.0
    default_cy = (STRIKE_ZONE_Y_MIN + STRIKE_ZONE_Y_MAX) / 2.0

    pose_centres_x: list[float] = []
    pose_mid_y: list[float] = []

    def _lm_xy(pose_landmarks, idx: int, min_vis: float = 0.25) -> Optional[tuple[float, float]]:
        try:
            lm = pose_landmarks.landmark[idx]
        except (AttributeError, IndexError):
            return None
        vis = lm.visibility if hasattr(lm, "visibility") else 1.0
        if vis < min_vis:
            return None
        return (float(lm.x), float(lm.y))

    for rd in raw_detections:
        pose = rd.get("pose_landmarks")
        if pose is None:
            continue
        shoulders = [_lm_xy(pose, 11), _lm_xy(pose, 12)]
        hips = [_lm_xy(pose, 23), _lm_xy(pose, 24)]
        xs = [p[0] for p in shoulders + hips if p is not None]
        if len(xs) >= 2:
            pose_centres_x.append(float(np.mean(xs)))
        ys = [p[1] for p in shoulders + hips if p is not None]
        if len(ys) >= 2:
            pose_mid_y.append(float(np.mean(ys)))

    pose_cx = _median_or_none(pose_centres_x)
    track_tail = sorted(track_points, key=lambda p: p.get("frame_id", 0))[-7:]
    tail_x = _median_or_none([float(p.get("cx", np.nan)) / width for p in track_tail])
    tail_y = _median_or_none([float(p.get("cy", np.nan)) / height for p in track_tail])
    catch_x = (float(catch_pt[0]) / width) if catch_pt else None
    catch_y = (float(catch_pt[1]) / height) if catch_pt else None

    if pose_cx is not None:
        center_x = 0.75 * pose_cx + 0.25 * (tail_x if tail_x is not None else default_cx)
    elif tail_x is not None:
        center_x = 0.65 * default_cx + 0.35 * tail_x
    elif catch_x is not None:
        center_x = 0.75 * default_cx + 0.25 * catch_x
    else:
        center_x = default_cx

    # The final approach/catch point is useful to compensate for camera tilt,
    # but a single pitch should not redefine the whole zone.  Keep the shift
    # damped and bounded around the umpire-POV default.
    final_y = catch_y if catch_y is not None else tail_y
    if final_y is not None:
        center_y = default_cy + 0.35 * (final_y - default_cy)
    else:
        center_y = default_cy

    if pose_mid_y:
        # If the pitcher pose is unusually high/low in the frame, it usually
        # indicates a tilted phone.  Apply a tiny correction only.
        pose_y = _median_or_none(pose_mid_y)
        if pose_y is not None:
            center_y += 0.08 * (pose_y - 0.40)

    center_x = _clamp_float(center_x, zone_w / 2.0 + 0.02, 1.0 - zone_w / 2.0 - 0.02)
    center_y = _clamp_float(center_y, zone_h / 2.0 + 0.02, 1.0 - zone_h / 2.0 - 0.02)

    zone = {
        "x_min": round(center_x - zone_w / 2.0, 4),
        "x_max": round(center_x + zone_w / 2.0, 4),
        "y_min": round(center_y - zone_h / 2.0, 4),
        "y_max": round(center_y + zone_h / 2.0, 4),
        "source": "auto",
    }
    log.info(
        "Auto strike-zone calibration: x=%.3f–%.3f y=%.3f–%.3f "
        "(pose_cx=%s tail=(%s,%s) catch=(%s,%s))",
        zone["x_min"], zone["x_max"], zone["y_min"], zone["y_max"],
        f"{pose_cx:.3f}" if pose_cx is not None else "none",
        f"{tail_x:.3f}" if tail_x is not None else "none",
        f"{tail_y:.3f}" if tail_y is not None else "none",
        f"{catch_x:.3f}" if catch_x is not None else "none",
        f"{catch_y:.3f}" if catch_y is not None else "none",
    )
    return zone


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

    重要：COCO 通用模型（如 yolo26n）的 class 32「sports ball」在實際棒球影片中
    往往不被偵測到（模型把棒球標記為 bird、apple 等）。
    因此在有多個類別的模型中，額外驗證「ball 類別是否真的有偵測到」；
    若第一幀完全沒有 ball_ids 中的偵測，代表此模型並非專用棒球模型，
    回傳 None（不做 class 過濾，讓 size/position 過濾器選出真正的球）。
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
    if not ball_ids:
        return None

    # 驗證：若模型有多個 class 且 first_result 完全沒有 ball_ids 中的偵測，
    # 代表這是通用 COCO 模型（例如 yolo26n）而非棒球專用模型。
    # 此時關閉 class 過濾，讓 size/position 過濾器處理，避免漏掉所有偵測。
    if first_result is not None and len(names_map) > 10:
        detected_cls_ids: set[int] = set()
        boxes = getattr(first_result, "boxes", None)
        if boxes is not None and boxes.cls is not None:
            for cls_val in boxes.cls.cpu().numpy():
                detected_cls_ids.add(int(cls_val))
        if detected_cls_ids and not (ball_ids & detected_cls_ids):
            # None of the "ball" class ids appear in detections → generic COCO model
            log.info(
                "ball_class_ids=%s not detected in first frame (detected=%s) "
                "→ disabling class filter (generic COCO model)",
                ball_ids, detected_cls_ids,
            )
            return None

    return ball_ids


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

    # 出手瞬間手臂高速甩動，要求較高的可見度門檻以避免模糊 landmark
    FINGER_MIN_VIS = 0.6   # 指尖：動態模糊下更容易漂移
    WRIST_MIN_VIS = 0.45   # 手腕：稍微穩定但仍需較高門檻

    if throwing_hand:
        fp = get_xy(int(throwing_hand["index_finger"]), FINGER_MIN_VIS)
        if fp is not None:
            return fp
        wp = get_xy(int(throwing_hand["wrist"]), WRIST_MIN_VIS)
        if wp is not None:
            return wp
        return None

    # throwing hand unknown → 收集所有候選
    candidates: list[tuple[tuple[int, int], float]] = []  # (point, visibility)
    for idx in (19, 20):  # index fingers
        r = get_xy_with_vis(idx, FINGER_MIN_VIS)
        if r is not None:
            candidates.append(r)
    if not candidates:
        for idx in (15, 16):  # wrists
            r = get_xy_with_vis(idx, WRIST_MIN_VIS)
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

    # COCO 通用模型（ball_class_ids=None）：使用嚴格尺寸過濾（只允許小物體），
    # 避免把投手身體（person bbox 330×390px）當成球。
    # 棒球相關 class（32=sports ball, 35=baseball glove）例外：允許任何尺寸通過。
    _COCO_BALL_CLASSES = {32, 35}  # sports ball, baseball glove

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

        # 若 ball_class_ids=None（COCO 通用模型），棒球相關 class（32/35）直接通過尺寸檢查；
        # 其他 class 適用嚴格尺寸過濾，避免把投手身體（person 330px）當成球。
        _is_coco_ball_cls = (ball_class_ids is None and cls_id_int in _COCO_BALL_CLASSES)

        if not _is_coco_ball_cls:
            # 單邊太大的一定不是球（避免把身體部位當球）
            if bw > max_single_side or bh > max_single_side:
                continue
        if bw < min_side or bh < min_side:
            continue

        area = bw * bh
        if area <= 0:
            continue
        if not _is_coco_ball_cls and area > max_area:
            continue

        aspect = (bw / (bh + 1e-6)) if bh > 0 else 999.0
        aspect = max(aspect, 1.0 / (aspect + 1e-6))
        if aspect > MAX_ASPECT_RATIO:
            continue

        cx = (x1 + x2) / 2.0
        cy = (y1 + y2) / 2.0

        # Exclude top of frame (sky / roof / background clutter)
        if cy < height * TOP_EXCLUDE_RATIO:
            continue

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


class _KalmanBallTracker:
    """Phase 1 即時 Kalman 球追蹤器。

    狀態向量：[cx, cy, vx, vy, w, h]
      - (cx, cy)：bbox 中心
      - (vx, vy)：速度（px/frame）
      - (w, h)  ：bbox 寬高（用於面積 gating）

    每幀流程：
      1. predict()       → 取得預測位置，用來裁 ROI
      2. update(det)     → 用偵測結果更新（YOLO 命中時）
      3. update_no_det() → 無偵測時僅做預測傳播（miss 計數 +1）

    連續 KALMAN_MAX_MISS 幀無偵測後 is_lost=True，停止輸出 ROI。
    """

    def __init__(self) -> None:
        self._kf = cv2.KalmanFilter(6, 4)   # 6 狀態, 4 觀測 (cx,cy,w,h)

        # 轉移矩陣 F：cx'=cx+vx, cy'=cy+vy, vx'=vx, vy'=vy, w'=w, h'=h
        self._kf.transitionMatrix = np.array([
            [1, 0, 1, 0, 0, 0],
            [0, 1, 0, 1, 0, 0],
            [0, 0, 1, 0, 0, 0],
            [0, 0, 0, 1, 0, 0],
            [0, 0, 0, 0, 1, 0],
            [0, 0, 0, 0, 0, 1],
        ], dtype=np.float32)

        # 觀測矩陣 H：觀測 cx, cy, w, h
        self._kf.measurementMatrix = np.array([
            [1, 0, 0, 0, 0, 0],
            [0, 1, 0, 0, 0, 0],
            [0, 0, 0, 0, 1, 0],
            [0, 0, 0, 0, 0, 1],
        ], dtype=np.float32)

        # 過程雜訊 Q：速度分量雜訊稍大（球加速度不可預測）
        self._kf.processNoiseCov = np.diag(
            [1.0, 1.0, 10.0, 10.0, 1.0, 1.0]
        ).astype(np.float32)

        # 觀測雜訊 R
        self._kf.measurementNoiseCov = np.diag(
            [4.0, 4.0, 16.0, 16.0]
        ).astype(np.float32)

        # 後驗誤差協方差初始值
        self._kf.errorCovPost = np.eye(6, dtype=np.float32) * 100.0

        self._initialized = False
        self._miss_count = 0
        self._last_w: float = 20.0
        self._last_h: float = 20.0

    # ── 初始化 ──────────────────────────────────────────────
    def initialize(self, cx: float, cy: float, w: float, h: float) -> None:
        state = np.array([[cx], [cy], [0.0], [0.0], [w], [h]], dtype=np.float32)
        self._kf.statePost = state
        self._kf.statePre  = state.copy()
        self._initialized = True
        self._miss_count = 0
        self._last_w = float(w)
        self._last_h = float(h)

    # ── 預測 ────────────────────────────────────────────────
    def predict(self) -> Optional[tuple[float, float, float, float]]:
        """回傳 (pred_cx, pred_cy, pred_w, pred_h) 或 None（未初始化或已 lost）。"""
        if not self._initialized or self.is_lost:
            return None
        pred = self._kf.predict()
        pcx = float(pred[0])
        pcy = float(pred[1])
        pw  = max(5.0, float(pred[4]))
        ph  = max(5.0, float(pred[5]))
        return pcx, pcy, pw, ph

    # ── 有偵測時更新 ─────────────────────────────────────────
    def update(self, cx: float, cy: float, w: float, h: float) -> None:
        meas = np.array([[cx], [cy], [w], [h]], dtype=np.float32)
        self._kf.correct(meas)
        self._miss_count = 0
        self._last_w = float(w)
        self._last_h = float(h)
        if not self._initialized:
            self._initialized = True

    # ── 無偵測時更新（miss）───────────────────────────────────
    def update_no_det(self) -> None:
        self._miss_count += 1

    # ── 狀態查詢 ─────────────────────────────────────────────
    @property
    def is_lost(self) -> bool:
        return self._miss_count >= KALMAN_MAX_MISS

    @property
    def miss_count(self) -> int:
        return self._miss_count

    @property
    def initialized(self) -> bool:
        return self._initialized


def _visual_gap_fill(
    raw_detections: list[dict],
    video_path: str,
    yolo_model,
    ball_class_ids: Optional[set[int]],
    width: int,
    height: int,
    rotate_code,          # cv2.ROTATE_* or None — same rotation as Phase 1
    *,
    roi_conf: float = GAPFILL_ROI_CONF,
    max_gap_frames: int = GAPFILL_MAX_GAP_FRAMES,
    roi_base_half: int = GAPFILL_ROI_BASE_HALF,
    roi_grow_per_frame: int = GAPFILL_ROI_GROW_PER_FRM,
) -> int:

    # 建立 frame_id → raw_detections index 的映射（frame_id 通常等於 index，但保險起見用 dict）
    fid_to_idx: dict[int, int] = {rd["frame_id"]: i for i, rd in enumerate(raw_detections)}

    # 找出有球偵測的所有幀（未過濾，包含 Phase 1 已過濾後有 det 的幀）
    detected_fids: list[int] = sorted(
        rd["frame_id"] for rd in raw_detections if rd["dets_list"]
    )
    if len(detected_fids) < 2:
        log.debug("Visual gap-fill: fewer than 2 detected frames, skipping")
        return 0

    flight_start = detected_fids[0]
    flight_end   = detected_fids[-1]

    # 收集空白幀段（flight_start~flight_end 之間沒有 dets_list 的幀）
    detected_set = set(detected_fids)
    gap_segments: list[list[int]] = []
    current_gap: list[int] = []
    for rd in raw_detections:
        fid = rd["frame_id"]
        if fid < flight_start or fid > flight_end:
            if current_gap:
                gap_segments.append(current_gap)
                current_gap = []
            continue
        if fid in detected_set:
            if current_gap:
                gap_segments.append(current_gap)
                current_gap = []
        else:
            current_gap.append(fid)
    if current_gap:
        gap_segments.append(current_gap)

    if not gap_segments:
        log.debug("Visual gap-fill: no gaps found within flight window")
        return 0

    # 預先計算每個偵測幀的 center 與 area（從 dets_list 取最高信心的那個）
    def _best_det_center_area(dets_list):
        if not dets_list:
            return None
        best = max(dets_list, key=lambda d: float(d[4]))
        x1, y1, x2, y2 = float(best[0]), float(best[1]), float(best[2]), float(best[3])
        cx = (x1 + x2) / 2.0
        cy = (y1 + y2) / 2.0
        area = max(0.0, (x2 - x1)) * max(0.0, (y2 - y1))
        return cx, cy, area

    det_info: dict[int, tuple] = {}
    for fid in detected_fids:
        rd = raw_detections[fid_to_idx[fid]]
        info = _best_det_center_area(rd["dets_list"])
        if info is not None:
            det_info[fid] = info  # (cx, cy, area)

    diag = float(np.hypot(width, height))
    corridor_px = diag * GAPFILL_CORRIDOR_RATIO
    n_filled = 0

    # ── 預先計算所有需要讀取的 gap 幀集合（避免重複讀）────────────────
    # 找出實際有效的 gap 段（長度在 max_gap_frames 內）
    valid_gap_segments: list[tuple[list[int], int | None, int | None]] = []
    for gap_fids in gap_segments:
        if len(gap_fids) > max_gap_frames:
            continue
        prev_fid = max((f for f in detected_fids if f < gap_fids[0]), default=None)
        next_fid = min((f for f in detected_fids if f > gap_fids[-1]), default=None)
        if det_info.get(prev_fid) is None:
            continue
        valid_gap_segments.append((gap_fids, prev_fid, next_fid))

    if not valid_gap_segments:
        return 0

    # 蒐集所有要讀的幀 ID，排序後順序讀一遍（避免隨機 seek）
    needed_fids: set[int] = set()
    for gap_fids, _, _ in valid_gap_segments:
        needed_fids.update(gap_fids)

    # ── 順序讀影片，把需要的幀存成 BGR dict ─────────────────────────
    gap_frames_bgr: dict[int, np.ndarray] = {}
    if needed_fids:
        gap_cap = cv2.VideoCapture(video_path)
        if not gap_cap.isOpened():
            log.warning("Visual gap-fill: cannot open video %s", video_path)
            return 0
        _min_need = min(needed_fids)
        _max_need = max(needed_fids)
        _cur_fid  = 0
        try:
            while _cur_fid <= _max_need:
                ret, frame_bgr = gap_cap.read()
                if not ret:
                    break
                if _cur_fid >= _min_need and _cur_fid in needed_fids:
                    if rotate_code is not None:
                        frame_bgr = cv2.rotate(frame_bgr, rotate_code)
                    gap_frames_bgr[_cur_fid] = frame_bgr
                _cur_fid += 1
        finally:
            gap_cap.release()

    n_filled = 0
    try:
        for gap_fids, prev_fid, next_fid in valid_gap_segments:
            prev_info = det_info.get(prev_fid)
            if prev_info is None:
                continue
            next_info = det_info.get(next_fid) if next_fid is not None else None
            prev_cx, prev_cy, prev_area = prev_info

            for gap_idx, gfid in enumerate(gap_fids):
                # ── 預測 ROI 中心 ──
                if next_fid is not None and next_info is not None:
                    # 雙錨點：線性內插
                    alpha = float(gfid - prev_fid) / float(next_fid - prev_fid)
                    pred_cx = prev_cx + alpha * (next_info[0] - prev_cx)
                    pred_cy = prev_cy + alpha * (next_info[1] - prev_cy)
                    expected_area = prev_area + alpha * (next_info[2] - prev_area)
                else:
                    # 單錨點：用最後兩個偵測幀做線性外插
                    if len(detected_fids) >= 2:
                        prev2_fid = detected_fids[-2] if prev_fid == detected_fids[-1] else None
                        if prev2_fid is not None and prev2_fid in det_info:
                            p2cx, p2cy, p2area = det_info[prev2_fid]
                            df = max(1, prev_fid - prev2_fid)
                            vx = (prev_cx - p2cx) / df
                            vy = (prev_cy - p2cy) / df
                        else:
                            vx = vy = 0.0
                    else:
                        vx = vy = 0.0
                    steps = gfid - prev_fid
                    pred_cx = prev_cx + vx * steps
                    pred_cy = prev_cy + vy * steps
                    expected_area = prev_area  # 靜態面積估計（外插時不知道終點）

                # 限制預測中心在畫面內
                pred_cx = float(np.clip(pred_cx, 0, width - 1))
                pred_cy = float(np.clip(pred_cy, 0, height - 1))

                # ── 計算 ROI ──
                half = roi_base_half + roi_grow_per_frame * min(gap_idx, len(gap_fids) - 1 - gap_idx)
                half = int(min(half, width // 5, height // 5))  # 最大 1/5 畫面
                x1_roi = int(max(0, pred_cx - half))
                y1_roi = int(max(0, pred_cy - half))
                x2_roi = int(min(width,  pred_cx + half))
                y2_roi = int(min(height, pred_cy + half))
                if x2_roi - x1_roi < 20 or y2_roi - y1_roi < 20:
                    continue  # ROI 太小，跳過

                # ── 從預先讀好的 dict 取幀 ──
                frame_bgr = gap_frames_bgr.get(gfid)
                if frame_bgr is None:
                    continue

                roi_bgr = frame_bgr[y1_roi:y2_roi, x1_roi:x2_roi]

                # ── YOLO 推論（低信心，小圖）──
                try:
                    roi_results = yolo_model.predict(
                        source=roi_bgr,
                        conf=roi_conf,
                        iou=0.3,
                        imgsz=320,
                        verbose=False,
                    )
                    roi_result = roi_results[0]
                except Exception as exc:
                    log.debug("Visual gap-fill YOLO error at frame %d: %s", gfid, exc)
                    continue

                # ── 收集候選並轉換回全幀座標 ──
                candidates: list[tuple[float, float, float, float, float, float]] = []
                for box in roi_result.boxes:
                    rx1, ry1, rx2, ry2 = box.xyxy[0].tolist()
                    conf_val = float(box.conf[0].item())
                    cls_val = -1.0
                    if hasattr(box, "cls") and box.cls is not None:
                        try:
                            cls_val = float(int(box.cls[0].item()))
                        except Exception:
                            pass

                    # 轉回全幀座標
                    fx1 = rx1 + x1_roi
                    fy1 = ry1 + y1_roi
                    fx2 = rx2 + x1_roi
                    fy2 = ry2 + y1_roi
                    candidates.append((fx1, fy1, fx2, fy2, conf_val, cls_val))

                if not candidates:
                    continue

                # ── 多層過濾 ──
                area_lo = GAPFILL_AREA_LO_RATIO * max(1.0, expected_area)
                area_hi = GAPFILL_AREA_HI_RATIO * max(1.0, expected_area)

                valid_cands = []
                for fx1, fy1, fx2, fy2, conf_val, cls_val in candidates:
                    cls_int = int(cls_val)
                    # 1. class filter
                    if ball_class_ids is not None and cls_int not in ball_class_ids:
                        continue
                    bw = max(0.0, fx2 - fx1)
                    bh = max(0.0, fy2 - fy1)
                    det_area = bw * bh
                    # 2. 尺寸合理性
                    if det_area < area_lo or det_area > area_hi:
                        continue
                    # 3. 長寬比
                    asp = (bw / (bh + 1e-6)) if bh > 0 else 999.0
                    asp = max(asp, 1.0 / (asp + 1e-6))
                    if asp > MAX_ASPECT_RATIO:
                        continue
                    # 4. 軌跡廊道（只在雙錨點時才做）
                    if next_fid is not None and next_info is not None:
                        dcx = (fx1 + fx2) / 2.0 - pred_cx
                        dcy = (fy1 + fy2) / 2.0 - pred_cy
                        # 距離預測點的像素距離（寬鬆一些，只擋離群點）
                        dist_from_pred = float(np.hypot(dcx, dcy))
                        if dist_from_pred > corridor_px:
                            continue
                    valid_cands.append((fx1, fy1, fx2, fy2, conf_val, cls_val))

                if not valid_cands:
                    continue

                # 取信心最高的那個
                best = max(valid_cands, key=lambda c: c[4])
                fx1, fy1, fx2, fy2, conf_val, cls_val = best
                new_det = np.array([fx1, fy1, fx2, fy2, conf_val, cls_val], dtype=float)

                # ── 回填進 raw_detections ──
                rd_idx = fid_to_idx.get(gfid)
                if rd_idx is not None:
                    raw_detections[rd_idx]["dets_list"] = [new_det]
                    raw_detections[rd_idx]["gap_filled"] = True
                    n_filled += 1
                    log.debug(
                        "Gap-fill frame %d: pred=(%.0f,%.0f) det=(%.0f,%.0f) conf=%.3f",
                        gfid, pred_cx, pred_cy,
                        (fx1 + fx2) / 2, (fy1 + fy2) / 2, conf_val,
                    )
    except Exception as _gf_err:
        log.warning("Visual gap-fill error: %s", _gf_err)

    if n_filled > 0:
        log.info("Phase 1.5 visual gap-fill: recovered %d frames", n_filled)
    else:
        log.info("Phase 1.5 visual gap-fill: no additional frames recovered")
    return n_filled


def _pick_best_track_id(
    tracks_by_id: dict[int, list[dict]],
    *,
    width: int,
    height: int,
    raw_detections: list[dict],
    first_ball_frame: Optional[int] = None,
) -> Optional[int]:
    """
    從 SORT 產生的多條 track 中挑出最像「球」的那一條。
    主要依據：總位移、平均速度、長度、bbox 面積偏小、少出現在腳踝/底部區域。
    飛行中的球必須有顯著位移（≥畫面對角線 5%），靜止/緩慢物體會被排除。

    first_ball_frame: 第一個高信心球偵測的幀號，用來排除在出球前就結束的 track
                      （這種 track 對應投手的風車動作或準備動作，不是飛行中的球）。
    """
    if not tracks_by_id:
        return None

    diag = float(np.hypot(width, height))
    min_displacement = diag * MIN_DISPLACEMENT_RATIO

    best_id = None
    best_score = -1e18

    log.info("Track selection: %d tracks, %dx%d, min_disp=%.0fpx, first_ball_frame=%s",
             len(tracks_by_id), width, height, min_displacement, first_ball_frame)

    for tid, items in tracks_by_id.items():
        # 至少 3 次偵測才算有效 track（2 點 track 極易為雜訊跳躍，需更多觀測）
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

        # ── Catcher POV size-growth metric ───────────────────────────
        # Camera is behind the catcher; the ball flies TOWARD the camera and grows.
        # Count what fraction of consecutive frame-pairs show a positive area increase.
        areas = [p[3] for p in pts]
        growing_pairs = sum(
            1 for i in range(1, len(areas)) if areas[i] > areas[i - 1]
        )
        growth_ratio = growing_pairs / max(1, len(areas) - 1)  # 0..1

        # Synthesise a "size displacement" proxy: total area growth across
        # the track (pixels²).  This replaces X/Y displacement for rear-view.
        area_growth_total = max(0.0, areas[-1] - areas[0])
        frame_area = float(width * height)
        # Normalise area growth the same way we normalise pixel displacement
        area_displacement_equiv = float(np.sqrt(area_growth_total)) * (
            diag / max(1.0, np.sqrt(frame_area))
        )

        # Effective displacement: max of pixel-disp and area-equiv-disp so
        # either a moving or a growing ball can be selected.
        effective_displacement = max(displacement, area_displacement_equiv * 0.5)

        # 位移不足的 track 直接跳過（靜止/微動物體不可能是飛行中的球）
        if effective_displacement < min_displacement:
            log.info(
                "  Track %d: pts=%d, disp=%.1fpx area_equiv=%.1fpx -> skip (low displacement)",
                tid, len(pts), displacement, area_displacement_equiv,
            )
            continue

        # 基礎分數：重度偏好「位移大、速度快」
        # displacement 用平方加權，確保靜止物體即使幀數多也無法超過飛行球
        score = (effective_displacement ** 2.0) * (avg_speed + 1.0) * (len(pts) ** 0.5) / ((avg_area + 1.0) ** 0.25)

        # Catcher POV bonus: strongly prefer tracks where bbox grows consistently
        if growth_ratio >= 0.6:
            score *= SIZE_GROWTH_WEIGHT * growth_ratio
            log.info("  Track %d: size-growth bonus x%.2f (growth_ratio=%.2f)", tid, SIZE_GROWTH_WEIGHT * growth_ratio, growth_ratio)

        # Catcher POV penalty: area shrinking >80% means the "ball" was a large
        # object that faded — almost certainly background clutter, not a pitch.
        if areas[0] > 0:
            area_shrink_ratio = (areas[0] - areas[-1]) / areas[0]  # 0=no shrink, 1=shrunk to 0
        else:
            area_shrink_ratio = 0.0
        if area_shrink_ratio > 0.8:
            score *= SIZE_SHRINK_PENALTY
            log.info(
                "  Track %d: size-shrink penalty x%.2f (area %.0f→%.0f, shrink=%.0f%%)",
                tid, SIZE_SHRINK_PENALTY, areas[0], areas[-1], area_shrink_ratio * 100,
            )

        # ── Catcher POV spatial validity check ──────────────────────────────
        # A real pitch in catcher-POV starts in the middle vertical band
        # (pitcher at ~20–55% of frame height) and ends LOWER (catcher at ~35–80%).
        y_start_norm = y_start / height
        y_end_norm   = y_end   / height
        x_start_norm = x_start / width
        x_end_norm   = x_end   / width

        # Hard reject: track starts in the excluded top zone
        if y_start_norm < TOP_EXCLUDE_RATIO:
            log.info("  Track %d: reject – starts in top exclusion zone (y=%.2f)", tid, y_start_norm)
            continue

        # Hard reject: track ends significantly ABOVE its start (ball moving away)
        if y_end_norm < y_start_norm - 0.05:
            log.info("  Track %d: reject – ball moving upward (y_start=%.2f y_end=%.2f)", tid, y_start_norm, y_end_norm)
            continue

        # Hard reject: track ends well before the first actual ball detection.
        # This eliminates wind-up / preparation motion tracks that never see the
        # actual ball in flight.  Allow a small look-ahead window (10 frames) for
        # cases where the track merges into the ball frame.
        _track_last_fid = pts[-1][2]
        if first_ball_frame is not None and _track_last_fid < first_ball_frame - 10:
            log.info(
                "  Track %d: reject – ends at frame %d, well before first ball frame %d",
                tid, _track_last_fid, first_ball_frame,
            )
            continue

        # Bonus: track starts near horizontal centre (pitcher is centred)
        cx_start_deviation = abs(x_start_norm - 0.5)
        if cx_start_deviation < 0.25:   # within 25% of centre
            centre_bonus = 1.0 + (0.25 - cx_start_deviation) * 2.0  # up to ×1.5
            score *= centre_bonus
            log.info("  Track %d: centre bonus x%.2f (cx_start=%.2f)", tid, centre_bonus, x_start_norm)

        # 懲罰項
        score *= (1.0 - 0.6 * min(bottom_frac, 1.0))
        score *= (1.0 - 0.8 * min(ankle_frac, 1.0))

        log.info(
            "  Track %d: pts=%d, start=(%.2f,%.2f) end=(%.2f,%.2f) disp=%.1fpx area_equiv=%.1fpx growth=%.0f%%, speed=%.1f, score=%.1f",
            tid, len(pts), x_start/width, y_start/height, x_end/width, y_end/height,
            displacement, area_displacement_equiv, growth_ratio * 100, avg_speed, score,
        )

        if score > best_score:
            best_score = score
            best_id = tid

    # ── Lenient fallback：嚴格門檻全部落空時，選最高速度的 2 點以上 track ──────
    # 確保偵測極稀疏（如逆光、遠距、強動態模糊）的影片仍能產生軌跡。
    if best_id is None and tracks_by_id:
        _fb_cands = [(tid, items) for tid, items in tracks_by_id.items() if len(items) >= 2]
        if _fb_cands:
            def _fb_score(items_list: list) -> float:
                _sit = sorted(items_list, key=lambda x: x["frame_id"])
                _spds: list[float] = []
                for _k in range(1, len(_sit)):
                    _df = max(1, _sit[_k]["frame_id"] - _sit[_k - 1]["frame_id"])
                    _dx = _sit[_k]["cx"] - _sit[_k - 1]["cx"]
                    _dy = _sit[_k]["cy"] - _sit[_k - 1]["cy"]
                    _spds.append(float(np.hypot(_dx, _dy)) / _df)
                return float(np.mean(_spds)) * len(items_list) if _spds else 0.0
            best_id = max(_fb_cands, key=lambda x: _fb_score(x[1]))[0]
            log.info(
                "Track selection: strict criteria all failed, "
                "lenient fallback → Track %d (%d pts)",
                best_id, len(tracks_by_id[best_id]),
            )

    if best_id is not None:
        log.info("Selected Track %d (score=%.1f)", best_id, best_score)
    else:
        log.info("No valid track found (all below displacement threshold)")

    return best_id


def _find_flight_end_frame(
    track_items: list[dict],
    fps: int,
) -> Optional[int]:

    if len(track_items) < 5:
        return None

    items = sorted(track_items, key=lambda x: x["frame_id"])

    # ── 信號 1：像素位移速度 ──────────────────────────────────────
    seg_vels: list[float] = []
    for i in range(1, len(items)):
        dx = items[i]["cx"] - items[i - 1]["cx"]
        dy = items[i]["cy"] - items[i - 1]["cy"]
        df = max(1, items[i]["frame_id"] - items[i - 1]["frame_id"])
        speed = float(np.hypot(dx, dy)) / df
        seg_vels.append(speed)

    if len(seg_vels) < 4:
        return None

    # FPS 自適應滑動窗口平滑（120fps 用 4 幀窗口，30fps 用 1 幀窗口）
    smooth_window = max(1, fps // 30)
    if smooth_window > 1 and len(seg_vels) >= smooth_window:
        smoothed_vels = [
            float(np.mean(seg_vels[max(0, i - smooth_window + 1): i + 1]))
            for i in range(len(seg_vels))
        ]
    else:
        smoothed_vels = seg_vels[:]

    # 用前 60% 的中位數作為飛行速度參考
    n_ref = max(3, int(len(smoothed_vels) * 0.6))
    median_speed = float(np.median(smoothed_vels[:n_ref]))

    if median_speed < 2.0:
        return None

    # 速度信號：降至 10%（比舊版 15% 更保守，減少誤截斷）
    vel_threshold = median_speed * 0.10

    # ── 信號 2：bbox 面積成長 ─────────────────────────────────────
    areas = [float(it.get("area", 0)) for it in items]
    has_area = any(a > 0 for a in areas)

    if has_area:
        n_ref_area = max(3, int(len(areas) * 0.6))
        median_area = float(np.median(areas[:n_ref_area]))

    # ── 從尾端向前掃描，找到飛行結束點 ───────────────────────────
    # 雙信號：速度低 AND 面積不再成長 → 才截斷
    end_item_idx = len(items) - 1

    for i in range(len(smoothed_vels) - 1, -1, -1):
        vel_ok = smoothed_vels[i] >= vel_threshold

        # 面積信號：若有面積資料，要求此幀之後面積仍在中位數的 120% 以上
        # （後方視角：飛行中的球面積一定會大於飛行初期的中位數）
        if has_area and median_area > 0:
            area_ok = areas[i + 1] >= median_area * 0.8 if i + 1 < len(areas) else True
        else:
            area_ok = True  # 無面積資料，只靠速度信號

        if vel_ok or area_ok:
            end_item_idx = i + 1
            break
    else:
        return None

    trimmed_count = len(items) - 1 - end_item_idx
    if trimmed_count <= 0:
        return None

    log.info(
        "Flight end detection: median_vel=%.1f px/f, threshold=%.1f (10%%), "
        "area_signal=%s, median_area=%.0f, "
        "smooth_window=%d, end_frame=%d, trimmed %d items (%.3fs)",
        median_speed, vel_threshold,
        "yes" if has_area else "no",
        median_area if has_area else 0,
        smooth_window,
        items[end_item_idx]["frame_id"],
        trimmed_count,
        trimmed_count / fps,
    )

    return items[end_item_idx]["frame_id"]


# ── Audio catch detection constants ──────────────────────────────────────────
AUDIO_SEARCH_MIN_OFFSET_S  = 0.10   # 接球最早：anchor + 100ms
AUDIO_SEARCH_MAX_OFFSET_S  = 1.20   # 接球最晚：anchor + 1200ms（含慢速球）
AUDIO_HOP_S                = 0.005  # 5ms 步進（亞幀精度）
AUDIO_FRAME_S              = 0.020  # 20ms 分析窗口（手套聲典型持續時間）
AUDIO_ONSET_THRESHOLD_STD  = 2.0    # 峰值閾值 = mean + 2*std（自適應）
AUDIO_MIN_PEAK_DIST_S      = 0.050  # 50ms 最小峰值間距（過濾殘響）
AUDIO_MAX_DIVERGENCE_S     = 0.75   # 信心閘：音訊優先，視覺只作寬鬆合理性檢查


def _has_audio_stream(video_path: str) -> bool:

    import json as _json
    try:
        out = subprocess.check_output(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_streams", video_path],
            stderr=subprocess.DEVNULL, text=True, timeout=15,
        )
        data = _json.loads(out)
        return any(
            s.get("codec_type") == "audio"
            and s.get("codec_name") not in (None, "unknown", "none", "")
            for s in data.get("streams", [])
        )
    except Exception:
        return False


def _detect_catch_from_audio(
    video_path: str,
    fps: float,
    first_ball_frame_idx: Optional[int],
    last_ball_frame_idx_visual: Optional[int],
    release_frame_idx: Optional[int] = None,
) -> Optional[int]:

    import tempfile
    import os as _os
    from scipy.io import wavfile as _wavfile
    from scipy.signal import find_peaks as _find_peaks
    import numpy as _np

    if not _has_audio_stream(video_path):
        log.info("Audio catch: no decodeable audio in %s", video_path)
        return None

    # 選擇錨點：優先用 release_frame_idx，退路用 first_ball_frame_idx
    anchor_frame_idx = release_frame_idx if release_frame_idx is not None else first_ball_frame_idx
    if anchor_frame_idx is None:
        log.info("Audio catch: no anchor frame (no release or first_ball), skipping")
        return None

    anchor_label = "release" if release_frame_idx is not None else "first_ball"
    log.info("Audio catch: anchor=%s (frame %d)", anchor_label, anchor_frame_idx)

    tmp_wav = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp_wav_path = tmp_wav.name
    tmp_wav.close()

    # ── 計算搜尋窗口（先算好，讓 ffmpeg 只萃取這段音訊）────────────────────
    anchor_s       = anchor_frame_idx / fps
    # 在錨點前多取 0.3s 緩衝，確保 ffmpeg seek 誤差不影響結果
    _clip_start_s  = max(0.0, anchor_s + AUDIO_SEARCH_MIN_OFFSET_S - 0.3)
    _clip_dur_s    = AUDIO_SEARCH_MAX_OFFSET_S - AUDIO_SEARCH_MIN_OFFSET_S + 0.6  # 總取段長度

    try:
        # ── 1. 僅萃取搜尋窗口那幾秒音訊（比轉整支快 5-10×）────────────────
        result = subprocess.run(
            ["ffmpeg", "-y",
             "-ss", f"{_clip_start_s:.3f}",   # seek 到錨點附近
             "-i", video_path,
             "-t", f"{_clip_dur_s:.3f}",       # 只取這幾秒
             "-vn", "-map", "0:a:0",
             "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "1",
             tmp_wav_path],
            capture_output=True, text=True, timeout=15,  # 短片段 timeout 也縮短
        )
        if result.returncode != 0:
            log.warning("Audio catch: ffmpeg failed (rc=%d): %s",
                        result.returncode, result.stderr[-200:] if result.stderr else "")
            return None

        # ── 2. 讀取音訊 ──────────────────────────────────────────────────────
        try:
            sr, raw_data = _wavfile.read(tmp_wav_path)
        except Exception as exc:
            log.warning("Audio catch: cannot read WAV: %s", exc)
            return None

        audio = raw_data.astype(_np.float32)
        if raw_data.dtype == _np.int16:
            audio /= 32768.0
        elif raw_data.dtype == _np.int32:
            audio /= 2_147_483_648.0
        # float32/float64 assumed already normalised

        audio_duration_s = len(audio) / sr

        # ── 3. 定義搜尋窗口（在已截取的短片段內尋找）────────────────────────
        # 因為音訊從 _clip_start_s 開始，需換算回片段內的相對時間
        search_start_s = max(0.0, (anchor_s + AUDIO_SEARCH_MIN_OFFSET_S) - _clip_start_s)
        search_end_s   = min(audio_duration_s, (anchor_s + AUDIO_SEARCH_MAX_OFFSET_S) - _clip_start_s)

        if search_end_s <= search_start_s:
            log.warning("Audio catch: window collapsed (%.3f–%.3fs)", search_start_s, search_end_s)
            return None

        start_sample = int(search_start_s * sr)
        end_sample   = int(search_end_s * sr)
        audio_seg    = audio[start_sample:end_sample]

        hop       = max(1, int(AUDIO_HOP_S * sr))
        frame_len = max(1, int(AUDIO_FRAME_S * sr))

        if len(audio_seg) < frame_len * 3:
            log.warning("Audio catch: search window too short (%d samples)", len(audio_seg))
            return None

        # ── 4. 短時 RMS 能量 ─────────────────────────────────────────────────
        n_frames = max(1, (len(audio_seg) - frame_len) // hop)
        rms = _np.array([
            _np.sqrt(_np.mean(audio_seg[i * hop: i * hop + frame_len] ** 2))
            for i in range(n_frames)
        ])

        # ── 5. Onset strength（半波整流一階差分）──────────────────────────────
        onset_strength = _np.maximum(_np.diff(rms, prepend=rms[0]), 0.0)

        # ── 6. 綜合分數（響亮 × 突然）────────────────────────────────────────
        score = onset_strength * rms

        # ── 7. 峰值偵測 ───────────────────────────────────────────────────────
        threshold = float(_np.mean(score) + AUDIO_ONSET_THRESHOLD_STD * _np.std(score))
        min_dist  = max(1, int(AUDIO_MIN_PEAK_DIST_S / AUDIO_HOP_S))
        peaks, _  = _find_peaks(score, height=threshold, distance=min_dist)

        if len(peaks) == 0:
            log.info("Audio catch: no peak in %.3f–%.3fs (thr=%.6f, max=%.6f)",
                     search_start_s, search_end_s, threshold, float(_np.max(score)))
            return None

        best_peak_idx = peaks[int(_np.argmax(score[peaks]))]
        # peak_time_s 是相對於片段開頭的時間，需加回 _clip_start_s 才是影片絕對時間
        peak_time_s   = _clip_start_s + search_start_s + best_peak_idx * AUDIO_HOP_S
        audio_frame   = int(round(peak_time_s * fps))

        log.info(
            "Audio catch: %d peak(s), best t=%.3fs → frame %d (score=%.6f, thr=%.6f, rms=%.4f)",
            len(peaks), peak_time_s, audio_frame,
            score[best_peak_idx], threshold, rms[best_peak_idx],
        )

        # ── 8. 信心閘 ─────────────────────────────────────────────────────────
        if last_ball_frame_idx_visual is not None:
            diff_s = abs(audio_frame - last_ball_frame_idx_visual) / fps
            if diff_s > AUDIO_MAX_DIVERGENCE_S:
                log.warning(
                    "Audio catch: frame %d diverges %.3fs from visual %d "
                    "(limit %.3fs) — discarded",
                    audio_frame, diff_s, last_ball_frame_idx_visual, AUDIO_MAX_DIVERGENCE_S,
                )
                return None
            log.info(
                "Audio catch: accepted (%.3fs from visual %d)",
                diff_s, last_ball_frame_idx_visual,
            )

        return audio_frame

    except Exception as exc:
        log.warning("Audio catch detection failed: %s", exc, exc_info=True)
        return None
    finally:
        try:
            _os.unlink(tmp_wav_path)
        except Exception:
            pass


# ── Catcher catch-point correction via trajectory extrapolation ─────────────
# YOLO loses the ball before it reaches the glove because the ball grows large
# and overlaps the catcher's body.  We extrapolate the trajectory forward using
# two independent signals and take the more conservative result:
#
#   Signal A – Area-growth extrapolation
#     In catcher-POV the ball's bbox area grows as 1/d² (inverse-square law).
#     We fit an exponential to the last N area samples and find when the area
#     would reach a "glove-size" threshold.  This is camera-distance agnostic.
#
#   Signal B – Polynomial trajectory extrapolation
#     Fit a 2nd-order polynomial to the last N (cx, cy) points and evaluate
#     at the frames predicted by Signal A.  Quadratic fitting captures the
#     natural downward arc of a pitch.
#
# If Signal A is unavailable (area not growing or too noisy), fall back to
# linear extrapolation toward the frame bottom (capped at 20% extra travel).
#
CATCH_EXTRAP_MIN_Y_NORM    = 0.45   # Don't extrapolate if track ended above this (too early)
CATCH_EXTRAP_MAX_Y_NORM    = 0.95   # Clamp extrapolated y to this (avoid going off-screen)
CATCH_EXTRAP_MAX_FRAMES    = 45     # Hard cap on how far forward we extrapolate
CATCH_EXTRAP_N_FIT         = 8      # Number of tail points used for poly/area fit
CATCH_EXTRAP_GLOVE_AREA_MULT = 3.5  # Glove bbox area ≈ this × last detected ball area
CATCH_EXTRAP_MAX_EXTRA_Y_FRAC = 0.20  # Linear fallback: extrapolate at most +20% of height
CATCH_EXTRAP_LARGE_AREA_PX2  = 3000  # If last area already > this, ball likely at glove already


def _extrapolate_catch_point(
    track_items: list[dict],
    width: int,
    height: int,
) -> Optional[tuple[int, int]]:
    """
    Estimate where the ball would have arrived at the catcher's glove using
    area-growth and polynomial trajectory extrapolation.

    Returns estimated (cx, cy) in raw pixel space, or None if extrapolation
    is not feasible or would not improve the existing track endpoint.
    """
    if len(track_items) < 4:
        return None

    last = track_items[-1]
    last_y_norm = last["cy"] / height

    # Already deep enough – no extrapolation needed
    if last_y_norm >= CATCH_EXTRAP_MAX_Y_NORM:
        return None

    # Ball area already very large → ball likely already at glove, no extrapolation needed
    last_area_check = float(last.get("area", 0))
    if last_area_check >= CATCH_EXTRAP_LARGE_AREA_PX2:
        log.info(
            "Catch extrapolation skipped: ball area %.0f >= threshold %.0f (already at glove)",
            last_area_check, CATCH_EXTRAP_LARGE_AREA_PX2,
        )
        return None

    # Track ended too high – likely a stray detection, skip
    if last_y_norm < CATCH_EXTRAP_MIN_Y_NORM:
        log.info(
            "Catch extrapolation skipped: track too high y_norm=%.3f (min=%.3f)",
            last_y_norm, CATCH_EXTRAP_MIN_Y_NORM,
        )
        return None

    # ── Collect tail points for fitting ──────────────────────────────────────
    tail = track_items[-min(CATCH_EXTRAP_N_FIT, len(track_items)):]
    fids  = np.array([it["frame_id"] for it in tail], dtype=float)
    cxs   = np.array([it["cx"]       for it in tail], dtype=float)
    cys   = np.array([it["cy"]       for it in tail], dtype=float)
    areas = np.array([float(it.get("area", 0)) for it in tail], dtype=float)

    # Normalise frame indices so polynomial fit is numerically stable
    f0    = fids[0]
    t     = fids - f0   # t[0]=0, t[-1]=last relative frame

    last_t = t[-1]
    last_fid = fids[-1]

    # ── Estimate velocity / direction from last 3–5 points ───────────────────
    n_vel = min(5, len(tail))
    frame_gap = max(1, tail[-1]["frame_id"] - tail[-n_vel]["frame_id"])
    vx = (tail[-1]["cx"] - tail[-n_vel]["cx"]) / frame_gap
    vy = (tail[-1]["cy"] - tail[-n_vel]["cy"]) / frame_gap

    # Ball must be moving downward (toward catcher) in catcher-POV footage
    if vy <= 0:
        log.info("Catch extrapolation skipped: ball not moving downward (vy=%.2f)", vy)
        return None

    # ── Signal A: area-growth extrapolation ──────────────────────────────────
    # Find frames_fwd_area = how many more frames until area hits glove threshold
    frames_fwd_area: Optional[float] = None
    last_area = areas[-1]
    if last_area > 0 and len(areas) >= 4:
        # Check whether area is consistently growing (>= 60% of steps increasing)
        area_diffs = np.diff(areas)
        growing = np.sum(area_diffs > 0) / max(1, len(area_diffs))
        if growing >= 0.55:
            # Fit linear trend to log(area) vs t  →  exponential model: A(t) = A0 * exp(k*t)
            log_areas = np.log(np.maximum(areas, 1.0))
            try:
                k_fit, log_a0 = np.polyfit(t, log_areas, 1)
            except Exception:
                k_fit = 0.0
            if k_fit > 0:
                # Solve: A0*exp(k*(last_t + dt)) = target_area  →  dt = (log(target/A(last_t)) / k)
                target_area = last_area * CATCH_EXTRAP_GLOVE_AREA_MULT
                dt_area = np.log(target_area / last_area) / k_fit
                if 0 < dt_area <= CATCH_EXTRAP_MAX_FRAMES:
                    frames_fwd_area = float(dt_area)
                    log.debug(
                        "Catch extrap Signal A: area %.0f→%.0f target, k=%.4f, dt=%.1f frames",
                        last_area, target_area, k_fit, dt_area,
                    )

    # ── Signal B: polynomial trajectory extrapolation ────────────────────────
    # Fit degree-2 poly to (t, cx) and (t, cy); evaluate at t = last_t + frames_fwd
    def poly_extrap(frames_fwd: float) -> tuple[int, int]:
        t_eval = last_t + frames_fwd
        # cx: linear fit (ball moves fairly straight horizontally)
        if len(t) >= 2:
            try:
                cx_coeffs = np.polyfit(t, cxs, min(2, len(t) - 1))
            except Exception:
                cx_coeffs = np.array([vx, tail[-1]["cx"]])
            est_cx = float(np.polyval(cx_coeffs, t_eval))
        else:
            est_cx = float(tail[-1]["cx"] + vx * frames_fwd)

        # cy: quadratic fit (captures pitch arc / gravity drop)
        if len(t) >= 3:
            try:
                cy_coeffs = np.polyfit(t, cys, min(2, len(t) - 1))
            except Exception:
                cy_coeffs = np.array([vy, tail[-1]["cy"]])
            est_cy = float(np.polyval(cy_coeffs, t_eval))
        else:
            est_cy = float(tail[-1]["cy"] + vy * frames_fwd)

        # Clamp to frame bounds
        est_cx = int(max(0, min(width - 1, est_cx)))
        est_cy = int(max(0, min(int(CATCH_EXTRAP_MAX_Y_NORM * height), est_cy)))
        return est_cx, est_cy

    # ── Choose frames_fwd ────────────────────────────────────────────────────
    if frames_fwd_area is not None:
        # Trust area-growth signal: it's physics-based and camera-distance agnostic
        frames_fwd = frames_fwd_area
        method = "area-growth"
    else:
        # Fallback: linear extrapolation capped at +20% of frame height
        max_extra_y = CATCH_EXTRAP_MAX_EXTRA_Y_FRAC * height
        if vy > 0:
            frames_fwd_lin = max_extra_y / vy
        else:
            log.info("Catch extrapolation skipped: vy=0 and no area signal")
            return None
        frames_fwd = min(frames_fwd_lin, float(CATCH_EXTRAP_MAX_FRAMES))
        method = "linear-fallback"

    if frames_fwd <= 0:
        return None

    est_cx, est_cy = poly_extrap(frames_fwd)

    # Sanity: extrapolated point must be strictly below the last detected point
    if est_cy <= last["cy"]:
        log.info(
            "Catch extrapolation result not useful: est_cy=%d <= last_cy=%d",
            est_cy, last["cy"],
        )
        return None

    log.info(
        "Catch extrapolation [%s]: track_end=(%d,%d) area=%.0f "
        "→ +%.1f frames → est=(%d,%d)  y_norm=%.3f→%.3f",
        method,
        last["cx"], last["cy"], last_area,
        frames_fwd, est_cx, est_cy,
        last_y_norm, est_cy / height,
    )
    return (est_cx, est_cy)


# ── RPM estimation via optical flow ────────────────────────────────────────
# 使用 tracks_by_id 取得精確的 frame_id 與球的 bbox 大小，
# 以逐幀順序讀取（不 seek）方式大幅提升穩定性。
# 注意：HEVC/H.264 壓縮 iPhone 影片中球的縫線僅 3-4px 寬，光流法信號極弱；
# 本函數在無可信信號時明確回傳 None，不輸出虛假估計值。
RPM_MIN_BALL_PX     = 20     # 最小球半徑（px in display space），低於此值紋理不足
RPM_MAX_FRAMES      = 60     # 最多採樣幀數
RPM_MIN_SAMPLES     = 5      # 需要至少此數量的有效量測才輸出結果
RPM_CROP_SIZE       = 64     # 固定 optical flow 計算尺寸（px）
RPM_VALID_MIN       = 700.0  # 合理棒球轉速下限（RPM）
RPM_VALID_MAX       = 4000.0 # 合理棒球轉速上限（RPM）
RPM_MIN_CONTRAST    = 12     # 球區域對背景的最低對比度（灰階，0-255）
RPM_MIN_BALL_MARGIN = 10     # 球邊緣外用於量測背景的額外像素


def _check_ball_visible(
    frame_bgr: np.ndarray,
    cx: int,
    cy: int,
    radius: int,
) -> bool:
    """Check if the ball at (cx, cy) with given radius is visually distinct
    from its immediate background (contrast check).

    Returns True only if the ball region has sufficient contrast to reliably
    track surface texture for optical flow.
    """
    fh, fw = frame_bgr.shape[:2]
    # Inner disk: ball region
    y1_b = max(0, cy - radius)
    y2_b = min(fh, cy + radius)
    x1_b = max(0, cx - radius)
    x2_b = min(fw, cx + radius)
    if y2_b <= y1_b or x2_b <= x1_b:
        return False
    ball_patch = frame_bgr[y1_b:y2_b, x1_b:x2_b]
    ball_mean = float(cv2.cvtColor(ball_patch, cv2.COLOR_BGR2GRAY).mean())

    # Outer annulus: background ring just outside the ball
    margin = RPM_MIN_BALL_MARGIN
    y1_o = max(0, cy - radius - margin)
    y2_o = min(fh, cy + radius + margin)
    x1_o = max(0, cx - radius - margin)
    x2_o = min(fw, cx + radius + margin)
    outer_patch = frame_bgr[y1_o:y2_o, x1_o:x2_o]
    outer_g = cv2.cvtColor(outer_patch, cv2.COLOR_BGR2GRAY).astype(np.float32)
    # Mask out the ball disk from the outer patch
    oy, ox = np.mgrid[0:outer_g.shape[0], 0:outer_g.shape[1]]
    ball_cy_in_outer = cy - y1_o
    ball_cx_in_outer = cx - x1_o
    bg_mask = (oy - ball_cy_in_outer) ** 2 + (ox - ball_cx_in_outer) ** 2 > radius ** 2
    if bg_mask.sum() < 10:
        return False
    bg_mean = float(outer_g[bg_mask].mean())

    return abs(ball_mean - bg_mean) >= RPM_MIN_CONTRAST


def _estimate_spin_rpm(
    video_path: str,
    ball_trajectory: list,
    fps: int,
    width: int,
    height: int,
    *,
    best_track_id: Optional[int] = None,
    tracks_by_id: Optional[dict] = None,
    rotate_code: Optional[int] = None,
) -> Optional[float]:
    """Estimate ball spin RPM using optical flow on the ball crop.

    核心邏輯：
    1. 從 tracks_by_id 取得精確 frame_id（cx/cy/area 均為 display space 座標）
    2. 按幀序順讀影片（不反覆 seek），提升速度與穩定性
    3. 球可見性檢查：僅在球對背景有足夠對比度的幀上計算光流
    4. 使用 CLAHE 增強對比，改善壓縮影片中的紋理不足問題
    5. IQR 雙層過濾（像素級 + 幀級），排除背景污染造成的離群值
    6. 無足夠可信樣本時明確回傳 None，不輸出虛假估計
    """
    # ── 必要條件檢查 ──────────────────────────────────────────────────────
    if tracks_by_id is None or best_track_id is None:
        log.info("RPM estimation: no track data available, skipping")
        return None

    track_items = sorted(
        tracks_by_id.get(best_track_id, []), key=lambda x: x["frame_id"]
    )
    if len(track_items) < RPM_MIN_SAMPLES + 1:
        log.info("RPM estimation: track too short (%d pts), skipping", len(track_items))
        return None

    # ── 掃描全段 track，從中選取球可見性最好的連續子段 ────────────────────
    # 優先使用飛行中段（排除出手抖動），但以可見性為主要篩選條件
    n = len(track_items)
    # 候選範圍：前 1/4 到後 3/4（排除出手前和接球後）
    cand_start = max(0, n // 8)
    cand_end   = min(n, cand_start + RPM_MAX_FRAMES + 10)
    candidates = track_items[cand_start:cand_end]

    if len(candidates) < 2:
        return None

    first_fid = candidates[0]["frame_id"]

    # ── 開啟影片並快速 seek 到起始幀（只 seek 一次） ─────────────────────────
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return None

    # ── CLAHE 對比增強器（改善 H.265/H.264 壓縮造成的紋理損失）──────────────
    clahe = cv2.createCLAHE(clipLimit=4.0, tileGridSize=(4, 4))

    angular_velocities: list[float] = []   # 通過物理範圍檢查的樣本

    try:
        # 只 seek 一次到起始幀，之後順序讀取
        cap.set(cv2.CAP_PROP_POS_FRAMES, float(first_fid))
        current_video_fid = first_fid

        prev_gray_crop: Optional[np.ndarray] = None
        prev_track_fid: int = -1

        for item in candidates:
            target_fid = item["frame_id"]
            cx = int(item["cx"])
            cy = int(item["cy"])
            area = float(item.get("area", 0.0))

            # 從目前位置順序讀到 target_fid（跳過中間幀）
            while current_video_fid < target_fid:
                ret_skip = cap.grab()  # 快速跳過（不解碼）
                if not ret_skip:
                    break
                current_video_fid += 1

            if current_video_fid != target_fid:
                cap.set(cv2.CAP_PROP_POS_FRAMES, float(target_fid))
                current_video_fid = target_fid

            ret, frame_bgr = cap.read()
            current_video_fid += 1
            if not ret:
                prev_gray_crop = None
                continue

            # 旋轉（與 Phase 1 保持一致）
            if rotate_code is not None:
                frame_bgr = cv2.rotate(frame_bgr, rotate_code)

            # ── 計算球半徑 ────────────────────────────────────────────────
            if area > 1.0:
                radius = int(np.sqrt(area / np.pi))
            else:
                radius = int(min(width, height) * 0.008)

            # 球太小：解析度不足以看到縫線紋理
            if radius < RPM_MIN_BALL_PX:
                prev_gray_crop = None
                continue

            # ── 球可見性檢查：跳過球融入背景的幀 ───────────────────────────
            if not _check_ball_visible(frame_bgr, cx, cy, radius):
                prev_gray_crop = None  # 重置，避免跨不可見幀計算光流
                continue

            # ── 裁切球區域（緊貼球邊緣，減少背景干擾）────────────────────
            pad = max(4, radius // 4)   # 只保留極少量邊緣
            x1 = max(0, cx - radius - pad)
            y1 = max(0, cy - radius - pad)
            x2 = min(frame_bgr.shape[1], cx + radius + pad)
            y2 = min(frame_bgr.shape[0], cy + radius + pad)
            crop = frame_bgr[y1:y2, x1:x2]
            if crop.size == 0 or crop.shape[0] < 8 or crop.shape[1] < 8:
                prev_gray_crop = None
                continue

            # ── 灰階 + CLAHE 增強 + 圓形遮罩（去除背景角落干擾）──────────
            gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
            gray = clahe.apply(gray)
            # 圓形遮罩：讓球外的背景像素歸零，防止背景流污染旋轉估計
            ball_mask = np.zeros_like(gray, dtype=np.float32)
            crop_cy = (y2 - y1) // 2
            crop_cx = (x2 - x1) // 2
            cv2.circle(ball_mask, (crop_cx, crop_cy), radius, 1.0, -1)
            gray_masked = (gray.astype(np.float32) * ball_mask).astype(np.uint8)
            # 縮放到固定大小（64×64），統一 optical flow 尺度
            gray_crop = cv2.resize(gray_masked, (RPM_CROP_SIZE, RPM_CROP_SIZE),
                                   interpolation=cv2.INTER_LANCZOS4)

            if prev_gray_crop is not None:
                frame_gap = max(1, target_fid - prev_track_fid)

                # ── Farneback optical flow ────────────────────────────────
                flow = cv2.calcOpticalFlowFarneback(
                    prev_gray_crop, gray_crop,
                    None,
                    pyr_scale=0.5, levels=4, winsize=11,
                    iterations=4, poly_n=7, poly_sigma=1.5,
                    flags=cv2.OPTFLOW_FARNEBACK_GAUSSIAN,
                )

                # ── 計算旋轉分量（角速度） ──────────────────────────────────
                # ω_per_pixel = (r × v) / |r|² = (rx*vy - ry*vx) / (rx²+ry²)
                S = RPM_CROP_SIZE
                cy_c = cx_c = S / 2.0
                ys, xs = np.mgrid[0:S, 0:S].astype(np.float32)
                rx = xs - cx_c
                ry = ys - cy_c
                r2 = rx * rx + ry * ry

                # 僅在球盤的中環區域計算（排除中心除零和邊緣雜訊）
                r_arr = np.sqrt(r2)
                r_min = S * 0.20
                r_max = S * 0.46
                ring_mask = (r_arr > r_min) & (r_arr < r_max)
                if ring_mask.sum() < 20:
                    prev_gray_crop = gray_crop
                    prev_track_fid = target_fid
                    continue

                vx_f = flow[:, :, 0]
                vy_f = flow[:, :, 1]
                cross = rx * vy_f - ry * vx_f
                omega_per_px = cross[ring_mask] / r2[ring_mask]

                # 以 IQR 過濾像素級離群值，取中位數作為本幀角速度
                q25, q75 = np.percentile(omega_per_px, [25, 75])
                iqr = q75 - q25
                valid_mask = (omega_per_px >= q25 - 1.5 * iqr) & (omega_per_px <= q75 + 1.5 * iqr)
                if valid_mask.sum() < 10:
                    prev_gray_crop = gray_crop
                    prev_track_fid = target_fid
                    continue
                omega = float(np.median(omega_per_px[valid_mask]))  # rad/frame

                # 換算成 RPM
                omega_per_sec = omega * fps / frame_gap   # rad/s
                rpm = abs(omega_per_sec) * 60.0 / (2.0 * np.pi)

                if RPM_VALID_MIN < rpm < RPM_VALID_MAX:
                    angular_velocities.append(rpm)

            prev_gray_crop = gray_crop
            prev_track_fid = target_fid

    finally:
        cap.release()

    # ── 判斷是否有足夠可信的樣本 ─────────────────────────────────────────
    if len(angular_velocities) < RPM_MIN_SAMPLES:
        log.info(
            "RPM estimation: only %d valid measurements (need %d) — returning None",
            len(angular_velocities), RPM_MIN_SAMPLES,
        )
        return None

    # ── IQR 過濾幀間離群值，再取中位數 ────────────────────────────────────
    arr = np.array(angular_velocities, dtype=float)
    if len(arr) >= 6:
        q25, q75 = np.percentile(arr, [25, 75])
        iqr = q75 - q25
        arr = arr[(arr >= q25 - 1.5 * iqr) & (arr <= q75 + 1.5 * iqr)]

    if len(arr) == 0:
        return None

    rpm_estimate = float(np.median(arr))
    rpm_estimate = float(np.clip(rpm_estimate, RPM_VALID_MIN, RPM_VALID_MAX))

    log.info(
        "RPM estimation: %d valid measurements → median=%.0f RPM (range %.0f–%.0f, fps=%d)",
        len(angular_velocities), rpm_estimate, float(arr.min()), float(arr.max()), fps,
    )
    return round(rpm_estimate, 0)


def get_pitch_frames_yolov8(
    video_path: str,
    yolo_model: YOLO,
    conf_threshold: float = 0.03,
    show_preview: bool = False,
    speed_calculator: Optional[BallSpeedCalculator] = None,
    batter_height_m: Optional[float] = None,
    strike_zone: Optional[dict] = None,
) -> tuple[list[FrameInfo], int, int, int, dict]:
    # Resolve strike-zone bounds: override from caller wins, else module defaults.
    manual_strike_zone = bool(strike_zone)
    if strike_zone:
        sz_x_min = float(strike_zone.get('x_min', STRIKE_ZONE_X_MIN))
        sz_x_max = float(strike_zone.get('x_max', STRIKE_ZONE_X_MAX))
        sz_y_min = float(strike_zone.get('y_min', STRIKE_ZONE_Y_MIN))
        sz_y_max = float(strike_zone.get('y_max', STRIKE_ZONE_Y_MAX))
        # Guard against inverted / zero-size zones
        if sz_x_max <= sz_x_min or sz_y_max <= sz_y_min:
            sz_x_min, sz_x_max = STRIKE_ZONE_X_MIN, STRIKE_ZONE_X_MAX
            sz_y_min, sz_y_max = STRIKE_ZONE_Y_MIN, STRIKE_ZONE_Y_MAX
    else:
        zone_w, zone_h, _ = _strike_zone_span_from_batter_height(batter_height_m)
        cx = (STRIKE_ZONE_X_MIN + STRIKE_ZONE_X_MAX) / 2.0
        cy = (STRIKE_ZONE_Y_MIN + STRIKE_ZONE_Y_MAX) / 2.0
        sz_x_min, sz_x_max = cx - zone_w / 2.0, cx + zone_w / 2.0
        sz_y_min, sz_y_max = cy - zone_h / 2.0, cy + zone_h / 2.0
    abs_zone_height_m = _abs_strike_zone_height_m(batter_height_m)
    log.info("Video from: %s (ext=%s)", video_path, os.path.splitext(video_path)[1].lower())
    # Use OpenCV to read the video information (width, height, FPS), the actual frame is read by YOLO26 later
    meta_cap = cv2.VideoCapture(video_path)
    if not meta_cap.isOpened():
        raise ValueError(
            f"無法開啟影片檔案：{video_path}\n請確認檔案格式是否支援（mp4/avi/mov/mkv）。"
        )

    fps = int(meta_cap.get(cv2.CAP_PROP_FPS))
    meta_cap.release()

    # ── Use ffprobe avg_frame_rate for true playback fps ──────────────────────
    # cv2.CAP_PROP_FPS returns r_frame_rate (e.g. 120) which is the coded max fps;
    # iPhone slow-motion videos have avg_frame_rate ≈ 110.3, so the overlay would
    # run 9% too fast when written at 120fps.  Prefer avg_frame_rate if available.
    _ffprobe_fps = _get_video_fps_ffprobe(video_path)
    if _ffprobe_fps is not None and _ffprobe_fps > 0:
        fps = round(_ffprobe_fps)
        log.info("ffprobe avg_frame_rate: %.4f → fps=%d", _ffprobe_fps, fps)

    # ── Use ffprobe to get the TRUE stored (coded) dimensions ─────────────────
    # cv2.CAP_PROP_FRAME_WIDTH/HEIGHT is unreliable: some OpenCV builds (e.g.
    # 4.11 in certain venvs) honour the video's rotation side-data and return the
    # *display* dimensions (e.g. 3722×2092 for a 2092×3722 portrait iPhone video),
    # while others return the raw stored dimensions.
    # ffprobe coded_width/coded_height always reflect physical storage, independent
    # of any rotation metadata — so we prefer it.
    _ffprobe_dims = _get_raw_video_dims_ffprobe(video_path)
    if _ffprobe_dims is not None:
        raw_width, raw_height = _ffprobe_dims
        log.info("ffprobe coded dims: %dx%d", raw_width, raw_height)
    else:
        # ffprobe not available; fall back to OpenCV property.
        # Re-open to avoid a second VideoCapture just for this.
        _fb_cap = cv2.VideoCapture(video_path)
        raw_width  = int(_fb_cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        raw_height = int(_fb_cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        _fb_ok, _fb_frame = _fb_cap.read()
        if _fb_ok:
            _mf_h, _mf_w = _fb_frame.shape[:2]
            if _mf_w != raw_width or _mf_h != raw_height:
                log.info(
                    "CAP_PROP_FRAME_WIDTH/HEIGHT %dx%d disagrees with actual frame %dx%d — "
                    "decoder applied rotation; using frame dims as raw dims.",
                    raw_width, raw_height, _mf_w, _mf_h,
                )
                raw_width, raw_height = _mf_w, _mf_h
        _fb_cap.release()
        log.info("OpenCV fallback dims: %dx%d", raw_width, raw_height)

    if raw_width <= 0 or raw_height <= 0:
        raise ValueError(
            f"無法讀取影片尺寸，可能是檔案損壞或格式不支援：{video_path}"
        )
    if fps <= 0:
        fps = 30
        log.warning("Cannot read fps, using default 30")

    # Detect display rotation (iPhone portrait videos have rotation=-90 in side data)
    _rotate_code = _get_video_rotation(video_path)
    # Phase 1 reads frames via cv2.VideoCapture and pre-rotates each frame
    # before passing to YOLO.  raw_width/raw_height are the stored (landscape)
    # dimensions; after rotation the display frame is disp_width × disp_height.
    # All YOLO bbox coords will be in display space after pre-rotation.
    width, height = raw_width, raw_height   # initial filter space (overridden below)
    if _rotate_code in (cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE):
        disp_width, disp_height = raw_height, raw_width   # display space after rotation
        log.info("Video rotation detected (code=%s): YOLO space %dx%d → display %dx%d",
                 _rotate_code, width, height, disp_width, disp_height)
    else:
        disp_width, disp_height = raw_width, raw_height
        if _rotate_code is not None:
            log.info("Video rotation 180°: display size unchanged %dx%d", disp_width, disp_height)

    # ── Format diagnostic summary ─────────────────────────────────────────────
    log.info(
        "VIDEO METADATA SUMMARY: ext=%s | fps=%d | raw=%dx%d | disp=%dx%d | "
        "rotate_code=%s",
        os.path.splitext(video_path)[1].lower(), fps,
        raw_width, raw_height, disp_width, disp_height,
        _rotate_code,
    )

    # Mutable flag: set to True in the first-frame detection block (below) when
    # the OpenCV/ffmpeg decoder has already applied the rotation metadata.
    # Using a list so _raw_to_disp can read the updated value via closure.
    _already_rotated_flag: list[bool] = [False]

    def _raw_to_disp(rx: int, ry: int) -> tuple[int, int]:
        if _already_rotated_flag[0]:
            # Decoder already rotated; coords are in display space
            return (rx, ry)
        if _rotate_code == cv2.ROTATE_90_CLOCKWISE:
            # Use raw_height (original stored height before any reassignment)
            return (raw_height - 1 - ry, rx)
        if _rotate_code == cv2.ROTATE_90_COUNTERCLOCKWISE:
            return (ry, raw_width - 1 - rx)
        if _rotate_code == cv2.ROTATE_180:
            return (raw_width - 1 - rx, raw_height - 1 - ry)
        return (rx, ry)

    pitch_frames: list[FrameInfo] = []
    raw_detections: list = []  # metadata only — no frame images stored
    frame_id = 0
    release_point = None
    
    release_detector = ReleasePointDetector(fps=fps)
    ball_class_ids: Optional[set[int]] = None

    pose = mp_pose.Pose(
        static_image_mode=False,
        model_complexity=1,          # Full model：側面/遠距拍攝時比 Lite (0) 偵測率高得多
        enable_segmentation=False,
        min_detection_confidence=0.3,  # 降低門檻：側面角度或遠距主體時偵測率低，需更寬鬆
        min_tracking_confidence=0.3,
    )

    # ── Phase 1：逐幀讀取 + YOLO 偵測（確保送進 YOLO 的是顯示方向影像） ──
    # 優先使用 AVFoundation 後端（macOS 硬體加速解碼，約快 2.5x）
    _cap_backends_to_try = []
    if hasattr(cv2, 'CAP_AVFOUNDATION'):
        _cap_backends_to_try.append(cv2.CAP_AVFOUNDATION)
    _cap_backends_to_try.append(cv2.CAP_ANY)
    phase1_cap = None
    for _backend in _cap_backends_to_try:
        _c = cv2.VideoCapture(video_path, _backend)
        if _c.isOpened():
            phase1_cap = _c
            log.info("Phase 1 VideoCapture backend: %s", _backend)
            break
        _c.release()
    if phase1_cap is None or not phase1_cap.isOpened():
        pose.close()
        raise RuntimeError(f"Cannot open video for Phase 1: {video_path}")

    # Detect on the first raw frame whether cv2 is giving us a pre-rotated
    # (landscape) frame.  If the frame is already in display orientation we
    # don't need to rotate; otherwise we apply _rotate_code.
    _p1_ok, _p1_first = phase1_cap.read()
    if not _p1_ok:
        pose.close()
        phase1_cap.release()
        raise RuntimeError(f"Cannot read first frame from video: {video_path}")

    _p1_fh, _p1_fw = _p1_first.shape[:2]
    # Display frame shape (after rotation) is disp_width × disp_height.
    if _rotate_code is not None and _p1_fw == disp_width and _p1_fh == disp_height:
        # cv2 already returned the display-oriented (rotated) frame.
        # No additional rotation needed; YOLO bboxes will be in display space.
        _phase1_rotate = None
        _already_rotated_flag[0] = True
        log.info(
            "Phase 1: cv2 pre-rotated to display orientation (%dx%d). "
            "No additional rotation will be applied.",
            _p1_fw, _p1_fh,
        )
    elif _rotate_code is not None:
        # cv2 gave us raw (landscape) frames; we must rotate before YOLO.
        _phase1_rotate = _rotate_code
        _already_rotated_flag[0] = True   # after rotation, bboxes → display space
        log.info(
            "Phase 1: cv2 gave raw frames (%dx%d), will rotate (code=%s) before YOLO.",
            _p1_fw, _p1_fh, _rotate_code,
        )
    else:
        _phase1_rotate = None
        _already_rotated_flag[0] = False
        log.info("Phase 1: no rotation needed (code=None), frames %dx%d.", _p1_fw, _p1_fh)

    # After we know the rotation intent, update width/height to display space
    # (YOLO will see display-oriented frames, so all bbox coords are in that space).
    width, height = disp_width, disp_height

    # Helper: apply rotation to a raw frame
    def _p1_rotate_frame(bgr: np.ndarray) -> np.ndarray:
        if _phase1_rotate is not None:
            return cv2.rotate(bgr, _phase1_rotate)
        return bgr

    # Initialise ball_class_ids from the very first frame
    _p1_first_rotated = _p1_rotate_frame(_p1_first)
    try:
        _first_results = yolo_model.predict(
            source=_p1_first_rotated,
            conf=conf_threshold,
            iou=0.3,
            imgsz=1280,
            verbose=False,
        )
        ball_class_ids = _infer_ball_class_ids(yolo_model, _first_results[0])
    except Exception as e:
        pose.close()
        phase1_cap.release()
        raise RuntimeError(f"無法使用 YOLO26 處理影片：{video_path}\n錯誤：{e}") from e

    # Re-wind to include frame 0 in the main loop
    phase1_cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    # ── 效能相關設定 ──
    _YOLO_BATCH_SIZE = 32           # 加大 batch：減少 GPU/MPS forward overhead 次數
    _POSE_STRIDE_BEFORE = 6         # 每 6 幀做一次 Pose（減少 Pose 開銷，出球點偵測仍足夠）
    _POSE_STRIDE_AFTER  = 8
    _POSE_STOP_AFTER_RELEASE = max(1, int(fps * 0.3))

    # 自適應 imgsz：
    # - 球出現前（風車動作）：imgsz=640，每 3 幀跑一次 YOLO（跳幀），大幅降低推論量
    # - 球出現後（飛行段）：imgsz=1280 全幀，確保細小快速球仍可偵測
    # 切換條件：需要 _P1_FLIGHT_CONFIRM_FRAMES 個連續幀都有球才確認飛行段，
    # 避免假陽性（例如投手手中的球）過早觸發高解析度模式。
    _P1_IMGSZ_PRESCAN  = 640   # 風車動作掃描解析度（低）
    _P1_IMGSZ_FLIGHT   = 640   # 飛行段解析度：維持 640，但改為每幀都跑（取消跳幀）
    _P1_IMGSZ          = _P1_IMGSZ_PRESCAN   # 初始值
    _P1_YOLO_STRIDE    = 3     # 球出現前每隔幾幀跑一次 YOLO（3=三幀取一）
    _p1_yolo_in_flight = False  # 是否已切換為飛行段模式
    _P1_FLIGHT_CONFIRM_FRAMES = max(3, int(fps * 0.05))  # 需連續 N 幀有球才切換（~0.05s）
    _p1_consecutive_ball_frames = 0  # 已連續偵測到球的幀數
    _p1_flight_switch_frame: Optional[int] = None  # 切換到飛行段時的幀號（用於 flight window 早停）
    _p1_flight_last_ball_frame: Optional[int] = None  # 飛行段最後一次偵測到快速移動球的幀號
    _P1_FLIGHT_GRACE_FRAMES = max(int(fps * 1.0), 60)  # 飛行段：球消失後最多再等 1s（含批次延遲 buffer）
    _p1_flight_last_det_cx: Optional[float] = None  # 上一幀偵測中心 x（用於速度估算）
    _p1_flight_last_det_cy: Optional[float] = None  # 上一幀偵測中心 y
    _P1_FLIGHT_MIN_MOVE_PX = max(width, height) * 0.004  # 移動閾值（佔畫面長邊 0.4%）

    # Phase 1 即時 Kalman 追蹤器（全幀 YOLO 沒命中時以 ROI 再試一次）
    _p1_kalman = _KalmanBallTracker()

    def _kalman_roi_detect(
        frame_bgr_disp: np.ndarray,
        pred_cx: float,
        pred_cy: float,
        pred_w: float,
        pred_h: float,
        miss_count: int,
        pose_lms,
    ) -> Optional[np.ndarray]:
        """用 Kalman 預測位置裁 ROI，低 conf 跑 YOLO，回傳最佳 det 或 None。

        回傳格式：np.ndarray([x1, y1, x2, y2, conf, cls_id])，座標為全幀空間。
        """
        half = int(min(
            KALMAN_ROI_BASE_HALF + KALMAN_ROI_GROW_PER_MISS * miss_count,
            width // 5,
            height // 5,
        ))
        x1_roi = int(max(0, pred_cx - half))
        y1_roi = int(max(0, pred_cy - half))
        x2_roi = int(min(width,  pred_cx + half))
        y2_roi = int(min(height, pred_cy + half))
        if x2_roi - x1_roi < 20 or y2_roi - y1_roi < 20:
            return None

        roi_bgr = frame_bgr_disp[y1_roi:y2_roi, x1_roi:x2_roi]
        try:
            roi_results = yolo_model.predict(
                source=roi_bgr,
                conf=KALMAN_ROI_CONF,
                iou=0.3,
                imgsz=320,
                verbose=False,
            )
        except Exception:
            return None

        expected_area = max(1.0, pred_w * pred_h)
        area_lo = KALMAN_AREA_LO_RATIO * expected_area
        area_hi = KALMAN_AREA_HI_RATIO * expected_area

        best_det: Optional[np.ndarray] = None
        best_conf = -1.0
        for box in roi_results[0].boxes:
            rx1, ry1, rx2, ry2 = box.xyxy[0].tolist()
            conf_val = float(box.conf[0].item())
            cls_val = -1.0
            if hasattr(box, "cls") and box.cls is not None:
                try:
                    cls_val = float(int(box.cls[0].item()))
                except Exception:
                    pass

            # class filter
            if ball_class_ids is not None and int(cls_val) not in ball_class_ids:
                continue

            bw = max(0.0, rx2 - rx1)
            bh = max(0.0, ry2 - ry1)
            det_area = bw * bh

            # 面積 gating
            if det_area < area_lo or det_area > area_hi:
                continue

            # 長寬比
            asp = (bw / (bh + 1e-6)) if bh > 0 else 999.0
            asp = max(asp, 1.0 / (asp + 1e-6))
            if asp > MAX_ASPECT_RATIO:
                continue

            if conf_val > best_conf:
                best_conf = conf_val
                # 轉回全幀座標
                fx1 = rx1 + x1_roi
                fy1 = ry1 + y1_roi
                fx2 = rx2 + x1_roi
                fy2 = ry2 + y1_roi
                best_det = np.array([fx1, fy1, fx2, fy2, conf_val, cls_val], dtype=float)

        if best_det is not None:
            # 用全幀過濾再確認一次（排除腳踝等）
            validated = _filter_candidate_dets(
                [best_det],
                width=width,
                height=height,
                ball_class_ids=ball_class_ids,
                pose_landmarks=pose_lms,
            )
            return validated[0] if validated else None

        return None

    # ── Phase 1 狀態追蹤 ─────────────────────────────────────────────────────
    _last_pose_result = None                       # 上次 Pose 推論結果（跳幀時複用）

    def _process_single_frame(
        fid: int,
        frame_disp: np.ndarray,
        dets_raw: list[np.ndarray],
    ) -> None:
        """處理單幀的 YOLO 結果：filter → Kalman → append raw_detections。"""
        nonlocal _last_pose_result

        # 複用最近一次 Pose 結果
        cur_pose = _last_pose_result
        has_p = cur_pose is not None and cur_pose.pose_landmarks is not None

        # Filter candidates
        dets_filtered = _filter_candidate_dets(
            dets_raw,
            width=width,
            height=height,
            ball_class_ids=ball_class_ids,
            pose_landmarks=cur_pose.pose_landmarks if has_p else None,
        )

        # Kalman 即時追蹤
        _p1_kpred = _p1_kalman.predict()
        _kalman_gap_filled = False

        if dets_filtered:
            _best_d = max(dets_filtered, key=lambda d: float(d[4]))
            _bx1, _by1, _bx2, _by2 = (
                float(_best_d[0]), float(_best_d[1]),
                float(_best_d[2]), float(_best_d[3]),
            )
            _p1_kalman.update(
                (_bx1 + _bx2) / 2, (_by1 + _by2) / 2,
                max(1.0, _bx2 - _bx1), max(1.0, _by2 - _by1),
            )
        else:
            if _p1_kpred is not None and not _p1_kalman.is_lost:
                _kpcx, _kpcy, _kpw, _kph = _p1_kpred
                _roi_det = _kalman_roi_detect(
                    frame_disp, _kpcx, _kpcy, _kpw, _kph,
                    _p1_kalman.miss_count,
                    cur_pose.pose_landmarks if has_p else None,
                )
                if _roi_det is not None:
                    dets_filtered = [_roi_det]
                    _kalman_gap_filled = True
                    _rx1, _ry1, _rx2, _ry2 = (
                        float(_roi_det[0]), float(_roi_det[1]),
                        float(_roi_det[2]), float(_roi_det[3]),
                    )
                    _p1_kalman.update(
                        (_rx1 + _rx2) / 2, (_ry1 + _ry2) / 2,
                        max(1.0, _rx2 - _rx1), max(1.0, _ry2 - _ry1),
                    )
                    log.debug(
                        "Kalman ROI gap-fill frame %d: pred=(%.0f,%.0f) "
                        "det=(%.0f,%.0f) conf=%.3f miss_before=%d",
                        fid, _kpcx, _kpcy,
                        (_rx1 + _rx2) / 2, (_ry1 + _ry2) / 2,
                        float(_roi_det[4]), _p1_kalman.miss_count,
                    )
                else:
                    _p1_kalman.update_no_det()
            else:
                _p1_kalman.update_no_det()

        raw_detections.append({
            "frame_id": fid,
            "dets_list": dets_filtered,
            "has_pose": has_p,
            "pose_landmarks": cur_pose.pose_landmarks if has_p else None,
            "pose_world_landmarks": cur_pose.pose_world_landmarks if has_p else None,
            "ankle_pts": _extract_ankles(cur_pose.pose_landmarks, width, height) if has_p else [],
            "kalman_gap_filled": _kalman_gap_filled,
        })

    try:
        # ── Batch 讀幀緩衝區 ─────────────────────────────────────────────────
        _batch_frames: list[np.ndarray] = []   # 緩衝的 display-oriented BGR 幀
        _batch_fids: list[int] = []             # 對應的 frame_id

        # ── Phase 1 早停狀態 ─────────────────────────────────────────────────
        # 邏輯：曾偵測到球 → Kalman lost → 再過 _EARLY_STOP_GRACE 幀仍無球 → 停止掃描
        # 避免繼續掃捕手接球後的背景幀（可省 30-60% YOLO 推論）
        # 球消失後 0.3s 觀察窗（夠讓接球後的最後幾幀也被 SORT 收到）
        _P1_EARLY_STOP_GRACE = max(int(fps * 0.3), 15)
        # 硬上限：投球動作一般在前 10 秒內出現，超過直接停止
        _P1_MAX_SCAN_SEC = 10.0
        _P1_MAX_SCAN_FRAMES = int(fps * _P1_MAX_SCAN_SEC)
        _p1_ball_ever_seen: bool = False    # 是否曾成功偵測到球
        _p1_lost_since: Optional[int] = None  # Kalman 宣告 lost 的幀號
        _p1_flight_last_fast_frame: Optional[int] = None  # 飛行段最後一次偵測到快球的幀號

        def _flush_batch():
            """將緩衝的幀批次送進 YOLO，回傳每幀的 dets_with_cls list。"""
            if not _batch_frames:
                return []
            try:
                batch_results = yolo_model.predict(
                    source=_batch_frames,
                    conf=conf_threshold,
                    iou=0.3,
                    imgsz=_P1_IMGSZ,
                    verbose=False,
                )
            except Exception as e:
                log.warning("YOLO batch predict failed: %s", e)
                return [[] for _ in _batch_frames]

            out = []
            for yolo_res in batch_results:
                dets: list[np.ndarray] = []
                for box in yolo_res.boxes:
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    score = float(box.conf[0].item())
                    cls_id = -1
                    if hasattr(box, "cls") and box.cls is not None:
                        try:
                            cls_id = int(box.cls[0].item())
                        except Exception:
                            pass
                    dets.append(np.array([x1, y1, x2, y2, score, cls_id], dtype=float))
                out.append(dets)
            return out

        while True:
            ret, frame_bgr = phase1_cap.read()
            if not ret:
                # 影片讀完，flush 剩餘 batch
                if _batch_frames:
                    _batch_yolo_results = _flush_batch()
                    for _bi, (_bfid, _bframe, _bdets_raw) in enumerate(
                        zip(_batch_fids, _batch_frames, _batch_yolo_results)
                    ):
                        _process_single_frame(_bfid, _bframe, _bdets_raw)
                    _batch_frames.clear()
                    _batch_fids.clear()
                break

            frame_bgr_disp = _p1_rotate_frame(frame_bgr)

            # ── 自適應 imgsz 切換（需連續多幀偵測到球才確認） ─────────────────
            # 避免假陽性（投手手中的球、背景干擾）過早切換到高解析度模式
            if not _p1_yolo_in_flight:
                # 更新連續幀計數（用已存的 raw_detections 最後一筆判斷）
                _last_det_has_ball = bool(
                    raw_detections and raw_detections[-1]["dets_list"]
                )
                if _last_det_has_ball:
                    _p1_consecutive_ball_frames += 1
                else:
                    _p1_consecutive_ball_frames = 0
                # 連續 N 幀都偵測到球 → 確認飛行段，切換高解析度
                if _p1_consecutive_ball_frames >= _P1_FLIGHT_CONFIRM_FRAMES:
                    _p1_yolo_in_flight = True
                    _P1_IMGSZ = _P1_IMGSZ_FLIGHT
                    _p1_flight_switch_frame = frame_id  # 記錄切換幀號，供 flight window 早停使用
                    log.info(
                        "Phase 1: confirmed ball flight (%d consecutive detections), "
                        "switching to imgsz=%d full-frame at frame %d",
                        _p1_consecutive_ball_frames, _P1_IMGSZ_FLIGHT, frame_id,
                    )

            # ── YOLO frame-skip（風車動作期跳幀）─────────────────────────────
            # 球出現前：每隔 _P1_YOLO_STRIDE 幀才送進 YOLO（節省大量推論）
            # 球出現後：每幀都送（確保軌跡完整，避免 SORT tracker 斷軌）
            _skip_this_frame = (
                not _p1_yolo_in_flight
                and frame_id % _P1_YOLO_STRIDE != 0
            )

            # ── Pose 推論（跳幀）────────────────────────────────────────────
            # 每 _POSE_STRIDE_BEFORE 幀做一次 Pose（全程固定 stride，不早停）
            _do_pose = (frame_id % _POSE_STRIDE_BEFORE == 0)

            if _do_pose:
                frame_rgb = cv2.cvtColor(frame_bgr_disp, cv2.COLOR_BGR2RGB)
                _last_pose_result = pose.process(frame_rgb)

            # 複用上次 Pose 結果
            results = _last_pose_result
            has_pose = results is not None and results.pose_landmarks is not None
            if _do_pose:
                if has_pose:
                    release_detector.add_frame(results.pose_landmarks, width, height)
                else:
                    release_detector.add_frame(None, width, height)

                # 不在 Phase 1 loop 內呼叫 detect_release_point()（太貴）
                # release 偵測統一在 Phase 1 結束後進行一次

            # ── 加入 batch 緩衝（跳幀的不進 YOLO，但仍需記錄以維持幀序） ──────
            if not _skip_this_frame:
                _batch_frames.append(frame_bgr_disp)
                _batch_fids.append(frame_id)
            else:
                # 跳幀：直接插入空偵測結果，保持 raw_detections 的幀序連續性
                _process_single_frame(frame_id, frame_bgr_disp, [])

            # 飛行段：每幀都立即 flush（batch size = 1），確保早停邏輯能讀到最新偵測結果
            # 風車動作段：批次 flush（batch size = _YOLO_BATCH_SIZE），減少 GPU 呼叫次數
            _effective_batch_size = 1 if _p1_yolo_in_flight else _YOLO_BATCH_SIZE

            # batch 滿了就 flush
            if len(_batch_frames) >= _effective_batch_size:
                _batch_yolo_results = _flush_batch()

                # 延遲處理：先把所有 batch 結果和 pose 結果對應起來
                # （Pose 結果用最後儲存的 _last_pose_result，各幀共用同一個）
                for _bi, (_bfid, _bframe, _bdets_raw) in enumerate(
                    zip(_batch_fids, _batch_frames, _batch_yolo_results)
                ):
                    _process_single_frame(_bfid, _bframe, _bdets_raw)

                _batch_frames.clear()
                _batch_fids.clear()

            # ── Phase 1 早停檢查 ─────────────────────────────────────────────
            if _p1_yolo_in_flight:
                # 飛行段：用相鄰幀偵測位移量判斷是否為真正快速移動的球
                # 靜態物體位移 ≈ 0；真實投球位移很大（數十 px/幀）
                # 注意：使用最後一筆已處理幀的 frame_id（而非目前 loop 的 frame_id），
                # 避免 batch 延遲造成比較基準錯位
                _last_proc_fid = raw_detections[-1]["frame_id"] if raw_detections else frame_id
                _cur_dets = raw_detections[-1]["dets_list"] if raw_detections else []
                if _cur_dets:
                    _best = max(_cur_dets, key=lambda d: float(d[4]))
                    _cur_cx = (float(_best[0]) + float(_best[2])) / 2.0
                    _cur_cy = (float(_best[1]) + float(_best[3])) / 2.0
                    if _p1_flight_last_det_cx is not None:
                        _dx = _cur_cx - _p1_flight_last_det_cx
                        _dy = _cur_cy - _p1_flight_last_det_cy
                        _det_speed = (_dx ** 2 + _dy ** 2) ** 0.5
                        if _det_speed >= _P1_FLIGHT_MIN_MOVE_PX:
                            _p1_flight_last_ball_frame = _last_proc_fid
                    _p1_flight_last_det_cx = _cur_cx
                    _p1_flight_last_det_cy = _cur_cy
                else:
                    _p1_flight_last_det_cx = None
                    _p1_flight_last_det_cy = None

                # 早停條件1：移動球出現後，消失超過 grace 幀 → 投球結束，可停止
                if (
                    _p1_flight_last_ball_frame is not None
                    and frame_id - _p1_flight_last_ball_frame >= _P1_FLIGHT_GRACE_FRAMES
                ):
                    log.info(
                        "Phase 1 early stop (ball gone): moving ball gone for %d frames "
                        "since frame %d, stopping at frame %d",
                        frame_id - _p1_flight_last_ball_frame,
                        _p1_flight_last_ball_frame, frame_id,
                    )
                    break

                # 早停條件2：切換後一直沒有移動球（假陽性觸發），等最多 3s 後放棄
                _P1_FLIGHT_MAX_NOBALL = max(int(fps * 3.0), 180)
                if (
                    _p1_flight_last_ball_frame is None
                    and _p1_flight_switch_frame is not None
                    and frame_id - _p1_flight_switch_frame >= _P1_FLIGHT_MAX_NOBALL
                ):
                    log.info(
                        "Phase 1 early stop (false flight): no moving ball in %d frames "
                        "since flight mode at frame %d, stopping at frame %d",
                        frame_id - _p1_flight_switch_frame,
                        _p1_flight_switch_frame, frame_id,
                    )
                    break
            else:
                # 風車動作段：舊邏輯（Kalman is_lost + grace）
                if raw_detections and raw_detections[-1]["dets_list"]:
                    _p1_ball_ever_seen = True
                    _p1_lost_since = None
                elif _p1_ball_ever_seen and _p1_kalman.is_lost:
                    if _p1_lost_since is None:
                        _p1_lost_since = frame_id
                    elif frame_id - _p1_lost_since >= _P1_EARLY_STOP_GRACE:
                        log.info(
                            "Phase 1 early stop: ball lost for %d frames (grace=%d), "
                            "stopping at frame %d",
                            frame_id - _p1_lost_since, _P1_EARLY_STOP_GRACE, frame_id,
                        )
                        break

            # 硬上限：超過最大掃描幀數立即停止（防止長影片無限掃描）
            if frame_id >= _P1_MAX_SCAN_FRAMES:
                log.info(
                    "Phase 1 hard limit: reached max scan frames (%d, %.1fs), stopping",
                    _P1_MAX_SCAN_FRAMES, _P1_MAX_SCAN_SEC,
                )
                break

            frame_id += 1

    finally:
        phase1_cap.release()
        pose.close()


    log.info("Phase 1 complete: data collection (%d frames)", frame_id)

    # 在 SORT 追蹤前，對 Phase 1 偵測到球的幀之間的空白幀做補偵測，
    # 用預測位置裁出小 ROI 以低 confidence 再推論，提升軌跡完整性與球速準確度。
    # fps-adaptive max_gap：高幀率慢動作影片（120/240fps）需要更大的 gap 容忍
    # 基準：至少 GAPFILL_MAX_GAP_FRAMES（60 幀）或 1.5 秒，取較大值
    _gapfill_max_gap = max(GAPFILL_MAX_GAP_FRAMES, int(fps * 1.5))
    log.info("Phase 1.5 gap-fill: fps=%d, max_gap=%d frames (%.2fs)",
             fps, _gapfill_max_gap, _gapfill_max_gap / max(1, fps))
    _visual_gap_fill(
        raw_detections,
        video_path,
        yolo_model,
        ball_class_ids,
        width,
        height,
        _phase1_rotate,   # 與 Phase 1 相同的旋轉代碼
        max_gap_frames=_gapfill_max_gap,
    )

    # Phase 1.5 gap-fill 會把補幀追加到 raw_detections 末尾（不按 frame_id 順序）。
    # Phase 2 的 SORT 追蹤、pitch_frames 建立、catch_frame_idx 都依 raw_detections
    # 的迭代順序運作，必須先按 frame_id 排好才能確保時序正確。
    raw_detections.sort(key=lambda rd: rd["frame_id"])

    # 執行多訊號出球點檢測
    optimal_release_frame_idx = None
    release_detection = None
    throwing_hand = release_detector.infer_throwing_hand()
    release_pose_frame_idx = None

    # 找出第一個有球偵測的幀，用於交叉驗證 release point
    # 優先找「高信心」偵測，避免低信心偵測誤判為第一球幀
    _first_ball_frame_for_validation = None
    _FIRST_BALL_HIGH_CONF = 0.35  # 高信心門檻
    # 第一輪：找第一個高信心偵測幀
    for _rd in raw_detections:
        if _rd.get("dets_list") and any(float(_dd[4]) >= _FIRST_BALL_HIGH_CONF for _dd in _rd["dets_list"] if len(_dd) > 4):
            _first_ball_frame_for_validation = _rd["frame_id"]
            break
    # 若無高信心偵測，fallback 到任何偵測
    if _first_ball_frame_for_validation is None:
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

    if optimal_release_frame_idx is not None and raw_detections:
        for delta in (0, -1, 1, -2, 2, -3, 3, -4, 4):
            idx = int(optimal_release_frame_idx + delta)
            if 0 <= idx < len(raw_detections) and raw_detections[idx].get("has_pose"):
                release_pose_frame_idx = idx
                break

    # 第二階段：使用檢測結果處理每一幀
    log.info("Phase 2: Applying release point detection")

    sort_tracker = Sort(max_age=10, min_hits=1, iou_threshold=0.1)
    tracks_by_id: dict[int, list[dict]] = {}
    tracks_by_frame: dict[int, dict[int, tuple[int, int]]] = {}

    # Track IDs that have been confirmed by at least one real detection
    _track_ids_with_real_det: set[int] = set()

    for frame_data in raw_detections:
        fid = frame_data["frame_id"]
        dets_list = frame_data["dets_list"]
        has_real_det = bool(dets_list)

        if has_real_det:
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

            if has_real_det:
                _track_ids_with_real_det.add(tid_int)

            # ── 只記錄「有真實偵測的幀」裡的 track 點 ──────────────────────────
            # SORT 即使無偵測也會用 Kalman 外推繼續報告 track（ghost points）。
            # 這些幽靈點會讓靜止背景物體看起來有位移，造成 _pick_best_track_id
            # 錯誤選擇假陽性 track。只在有真實偵測（dets_list 不空）的幀才記錄，
            # 確保 tracks_by_id 只含真實偵測確認過的位置。
            if not has_real_det:
                continue

            tracks_by_id.setdefault(tid_int, []).append(
                {"frame_id": fid, "cx": cx, "cy": cy, "area": area}
            )
            tracks_by_frame.setdefault(fid, {})[tid_int] = (cx, cy)

    # ── SORT 後處理：合併時間連續且空間相容的 track 片段 ───────────────────────
    # 同一顆球因方向突然改變（如捕手視角的球弧頂點）可能被 SORT 切割成多段 track。
    # 策略：對每對 (A, B) track，若 A 結束幀 ≤ B 起始幀 + OVERLAP_FRAMES（允許少量重疊）
    #   且 A 末端與 B 起點的直接空間距離 ≤ MERGE_ENDPOINT_TOL，
    #   且 A 或 B 至少一段速度 ≥ MERGE_MIN_SPEED（防止純雜訊 track 串連），
    #   則把 B 的（在 A 末端之後的）點合入 A，允許多輪合併。
    _MERGE_FRAME_GAP      = 8    # A 結束後最多 N 幀才可與 B 合併（正值=gap，允許小 overlap 見下）
    _MERGE_OVERLAP        = 10   # 允許 A/B 輕微重疊（幀數），處理 SORT 產生的並行 track 過渡
    _MERGE_ENDPOINT_TOL   = 250  # A 末端與 B 起點的直接距離容忍（px），需寬鬆以應對方向反轉
    _MERGE_MIN_SPEED      = 10.0 # px/frame：A 或 B 至少一段需有此速度才允許合併

    def _track_avg_speed(items_sorted: list[dict]) -> float:
        if len(items_sorted) < 2:
            return 0.0
        speeds = []
        for _k in range(1, len(items_sorted)):
            _df = max(1, items_sorted[_k]["frame_id"] - items_sorted[_k-1]["frame_id"])
            _dx = items_sorted[_k]["cx"] - items_sorted[_k-1]["cx"]
            _dy = items_sorted[_k]["cy"] - items_sorted[_k-1]["cy"]
            speeds.append(float(np.hypot(_dx, _dy)) / _df)
        return float(np.mean(speeds))

    # 允許多輪合併（每輪直至無更多合併為止）
    _merge_changed = True
    while _merge_changed:
        _merge_changed = False
        _track_list = sorted(
            tracks_by_id.items(),
            key=lambda kv: min(x["frame_id"] for x in kv[1]),
        )
        _merged_into: dict[int, int] = {}

        for _ai, (_tid_a, _items_a) in enumerate(_track_list):
            if _tid_a in _merged_into:
                continue
            _a_sorted  = sorted(_items_a, key=lambda x: x["frame_id"])
            _a_end_fid = _a_sorted[-1]["frame_id"]
            _ax_end    = float(_a_sorted[-1]["cx"])
            _ay_end    = float(_a_sorted[-1]["cy"])
            _a_speed   = _track_avg_speed(_a_sorted)

            for _tid_b, _items_b in _track_list[_ai + 1:]:
                if _tid_b in _merged_into:
                    continue
                _b_sorted    = sorted(_items_b, key=lambda x: x["frame_id"])
                _b_start_fid = _b_sorted[0]["frame_id"]
                # 允許少量重疊（SORT 產生的過渡期並行 track）或有 gap
                _gap_or_overlap = _b_start_fid - _a_end_fid
                if _gap_or_overlap < -_MERGE_OVERLAP or _gap_or_overlap > _MERGE_FRAME_GAP:
                    continue
                _b_speed = _track_avg_speed(_b_sorted)
                if max(_a_speed, _b_speed) < _MERGE_MIN_SPEED:
                    continue
                # A 末端與 B 起點的直接距離
                _bx_start = float(_b_sorted[0]["cx"])
                _by_start = float(_b_sorted[0]["cy"])
                _dist = float(np.hypot(_ax_end - _bx_start, _ay_end - _by_start))
                if _dist <= _MERGE_ENDPOINT_TOL:
                    log.info(
                        "Merging Track %d (ends f%d, spd=%.1f, pos=(%.0f,%.0f)) "
                        "→ Track %d (starts f%d, spd=%.1f, pos=(%.0f,%.0f)): "
                        "gap=%d frames, dist=%.1fpx",
                        _tid_a, _a_end_fid, _a_speed, _ax_end, _ay_end,
                        _tid_b, _b_start_fid, _b_speed, _bx_start, _by_start,
                        _gap_or_overlap, _dist,
                    )
                    # 把 B 中幀號 > A 末端的點搬入 A（避免重複幀）
                    _b_new_pts = [_pt for _pt in _items_b if _pt["frame_id"] > _a_end_fid]
                    tracks_by_id[_tid_a].extend(_b_new_pts)
                    for _pt in _b_new_pts:
                        _fid_b = _pt["frame_id"]
                        if _fid_b in tracks_by_frame and _tid_b in tracks_by_frame[_fid_b]:
                            tracks_by_frame[_fid_b][_tid_a] = tracks_by_frame[_fid_b].pop(_tid_b)
                    del tracks_by_id[_tid_b]
                    _merged_into[_tid_b] = _tid_a
                    tracks_by_id[_tid_a] = sorted(
                        tracks_by_id[_tid_a], key=lambda x: x["frame_id"]
                    )
                    _merge_changed = True
                    break

    best_track_id = _pick_best_track_id(
        tracks_by_id, width=width, height=height, raw_detections=raw_detections,
        first_ball_frame=_first_ball_frame_for_validation,
    )

    # ── 向後延伸 best track 的起始點（應對捕手視角球弧起點被切掉的情況）──────────
    # 若 _first_ball_frame_for_validation 比 best track 的起始幀更早，
    # 且中間幀都有「高信心」偵測（真球），則把這些幀的偵測點加入 best track，
    # 以使飛行時間計算更準確（從球真正出現的幀開始計）。
    if best_track_id is not None and best_track_id in tracks_by_id:
        _bt_sorted = sorted(tracks_by_id[best_track_id], key=lambda x: x["frame_id"])
        _bt_first_fid = _bt_sorted[0]["frame_id"]
        _bt_first_cx  = float(_bt_sorted[0]["cx"])
        _bt_first_cy  = float(_bt_sorted[0]["cy"])

        _BACKWARD_EXT_CONF    = 0.35   # 只接受高信心偵測
        _BACKWARD_EXT_RADIUS  = 300    # 連接容忍半徑（px），方向反轉時需較寬
        _BACKWARD_EXT_MAX_GAP = 50     # 最多往前看幾幀

        if (
            _first_ball_frame_for_validation is not None
            and _first_ball_frame_for_validation < _bt_first_fid
            and (_bt_first_fid - _first_ball_frame_for_validation) <= _BACKWARD_EXT_MAX_GAP
        ):
            # 收集 [_first_ball_frame_for_validation, _bt_first_fid) 之間的高信心偵測
            _ext_pts: list[dict] = []
            _last_ext_cx = _bt_first_cx
            _last_ext_cy = _bt_first_cy
            # 從 bt_first 往前掃
            _ext_fids = range(_first_ball_frame_for_validation, _bt_first_fid)
            for _ext_fid in reversed(_ext_fids):
                _ext_rd = None
                for _rd in raw_detections:
                    if _rd["frame_id"] == _ext_fid:
                        _ext_rd = _rd
                        break
                if _ext_rd is None or not _ext_rd.get("dets_list"):
                    continue
                # 取最高信心偵測
                _best_dd = max(_ext_rd["dets_list"], key=lambda d: float(d[4]))
                if float(_best_dd[4]) < _BACKWARD_EXT_CONF:
                    continue
                _ecx = (_best_dd[0] + _best_dd[2]) / 2.0
                _ecy = (_best_dd[1] + _best_dd[3]) / 2.0
                _edist = float(np.hypot(_ecx - _last_ext_cx, _ecy - _last_ext_cy))
                if _edist > _BACKWARD_EXT_RADIUS:
                    break  # 離得太遠，不再往前追
                _ext_pts.append({"frame_id": _ext_fid, "cx": int(_ecx), "cy": int(_ecy),
                                  "area": float((_best_dd[2]-_best_dd[0]) * (_best_dd[3]-_best_dd[1]))})
                _last_ext_cx = _ecx
                _last_ext_cy = _ecy

            if _ext_pts:
                # 從舊到新排序後加入 best track
                _ext_pts_sorted = sorted(_ext_pts, key=lambda x: x["frame_id"])
                tracks_by_id[best_track_id] = _ext_pts_sorted + tracks_by_id[best_track_id]
                tracks_by_id[best_track_id] = sorted(
                    tracks_by_id[best_track_id], key=lambda x: x["frame_id"]
                )
                # 更新 tracks_by_frame
                for _ept in _ext_pts_sorted:
                    tracks_by_frame.setdefault(_ept["frame_id"], {})[best_track_id] = (
                        _ept["cx"], _ept["cy"]
                    )
                log.info(
                    "Backward track extension: prepended %d frames (%d→%d) to best track %d",
                    len(_ext_pts_sorted),
                    _ext_pts_sorted[0]["frame_id"],
                    _ext_pts_sorted[-1]["frame_id"],
                    best_track_id,
                )

    # ── 飛行結束偵測：分析軌跡速度，找出球被接住的幀 ──
    flight_end_frame: Optional[int] = None
    if best_track_id is not None and best_track_id in tracks_by_id:
        flight_end_frame = _find_flight_end_frame(
            tracks_by_id[best_track_id], fps
        )

    # ── 音訊接球偵測（flight_end 第一優先）────────────────────────────────────
    # 偵測手套聲衝擊音，若通過寬鬆信心閘則作為速度計算終點。
    # 音訊偵測失敗時（無音軌、無明顯峰值、差異過大）才退回視覺法。

    # 取得 best track 的最後一幀，作為音訊偵測的參考錨點
    # （接球聲必須發生在 YOLO 最後一次偵測到球的附近）
    _track_end_fid_for_audio: Optional[int] = None
    if best_track_id is not None and best_track_id in tracks_by_id:
        _track_items_sorted = sorted(tracks_by_id[best_track_id], key=lambda x: x["frame_id"])
        if _track_items_sorted:
            _track_end_fid_for_audio = _track_items_sorted[-1]["frame_id"]

    # 音訊搜尋錨點優先順序：
    # 1. release_frame_idx（投球釋放幀）— 物理上飛行時間起點
    # 2. first_ball_frame_idx（YOLO 第一次偵測）— 退路
    # 信心閘參考：flight_end_frame（視覺法）或 _track_end_fid_for_audio（track 最後幀）
    _audio_visual_ref = flight_end_frame if flight_end_frame is not None else _track_end_fid_for_audio
    audio_catch_frame: Optional[int] = _detect_catch_from_audio(
        video_path=video_path,
        fps=fps,
        first_ball_frame_idx=_first_ball_frame_for_validation,
        last_ball_frame_idx_visual=_audio_visual_ref,
        release_frame_idx=optimal_release_frame_idx,  # 優先用投球釋放幀當搜尋錨點
    )
    if audio_catch_frame is not None:
        # 安全性檢查：音訊偵測幀必須晚於 best track 最後一幀的 0.5 秒以前。
        # 理由：接球聲在球接觸手套時產生，必定在 YOLO 最後偵測到球的幀「之後或接近」。
        # 若音訊幀比 track 最後幀還早超過 0.5 秒，則判定為環境音（呼喊、腳步聲），捨棄。
        _AUDIO_EARLY_TOLERANCE_S = 0.5
        if (_track_end_fid_for_audio is not None
                and audio_catch_frame < _track_end_fid_for_audio - _AUDIO_EARLY_TOLERANCE_S * fps):
            log.warning(
                "Audio catch frame %d is %.3fs before track_end_frame %d "
                "(tolerance %.1fs) — likely pre-catch sound, discarded",
                audio_catch_frame,
                (_track_end_fid_for_audio - audio_catch_frame) / fps,
                _track_end_fid_for_audio,
                _AUDIO_EARLY_TOLERANCE_S,
            )
        else:
            log.info(
                "Using audio catch frame %d (visual was: %s, track_end=%s)",
                audio_catch_frame, str(flight_end_frame), str(_track_end_fid_for_audio),
            )
            flight_end_frame = audio_catch_frame
    else:
        log.info(
            "Audio catch unavailable; keeping visual flight_end_frame=%s",
            str(flight_end_frame),
        )

    first_release_adjusted = False
    first_ball_frame_idx = None

    # 計算 best track 的起始幀（用於軌跡裁切的 fallback）
    # 當沒有 release frame 且 _first_ball_frame_for_validation 是假陽性時，
    # 用 best track 的真正起始幀作為軌跡起點，避免把風車動作或假陽性畫入軌跡。
    _best_track_start_fid: Optional[int] = None
    if best_track_id is not None and best_track_id in tracks_by_id:
        _bt_items = sorted(tracks_by_id[best_track_id], key=lambda x: x["frame_id"])
        if _bt_items:
            _best_track_start_fid = _bt_items[0]["frame_id"]

    last_point = None
    last_vel = None

    # 幀影像由 generate_overlay 在 Overlay 階段統一讀取（只讀一次），
    # 這裡只存 ball 座標與 pose landmarks，FrameInfo.frame = None。
    _EMPTY_FRAME = None  # generate_overlay 會自己讀影片
    for frame_data in raw_detections:
        fid = frame_data["frame_id"]
        has_pose = frame_data["has_pose"]
        pose_landmarks = frame_data["pose_landmarks"]
        pose_world_landmarks = frame_data.get("pose_world_landmarks")
        frame_rgb = _EMPTY_FRAME  # noqa: F841 – kept for clarity, never written to VideoWriter directly

        if (
            not first_release_adjusted
            and release_pose_frame_idx is not None
            and fid == release_pose_frame_idx
            and has_pose
        ):
            _fbp = None
            if _first_ball_frame_for_validation is not None:
                for _rd in raw_detections:
                    if _rd["frame_id"] == _first_ball_frame_for_validation and _rd["dets_list"]:
                        _d = _rd["dets_list"][0]
                        _fbp = (int((_d[0] + _d[2]) / 2), int((_d[1] + _d[3]) / 2))
                        break
            rp = _extract_release_point_from_pose(
                pose_landmarks, image_w=width, image_h=height,
                throwing_hand=throwing_hand, first_ball_point=_fbp,
            )
            if rp is not None:
                rp_valid, rp_fails = _validate_release_point_with_pose(
                    pose_landmarks, rp, throwing_hand, _fbp, width, height,
                    pose_world_landmarks=pose_world_landmarks,
                )
                if rp_valid:
                    release_point = rp
                    first_release_adjusted = True
                    log.info("Release point recorded from pose frame %d (validated)", fid)
                else:
                    log.warning(
                        "Release point at frame %d failed pose validation: %s — "
                        "scanning forward for best elbow frame",
                        fid, "; ".join(rp_fails),
                    )
                    # 往後掃描手肘最伸直的幀
                    _scan_end = _first_ball_frame_for_validation if _first_ball_frame_for_validation is not None else fid + ELBOW_SCAN_LOOKAHEAD
                    _bf, _bp, _bw, _ba = _find_best_elbow_frame(
                        raw_detections, fid, throwing_hand, end_fid=_scan_end
                    )
                    if _bf is not None:
                        rp2 = _extract_release_point_from_pose(
                            _bp, image_w=width, image_h=height,
                            throwing_hand=throwing_hand, first_ball_point=_fbp,
                        )
                        if rp2 is not None:
                            rp2_valid, rp2_fails = _validate_release_point_with_pose(
                                _bp, rp2, throwing_hand, _fbp, width, height,
                                pose_world_landmarks=_bw,
                            )
                            if rp2_valid:
                                release_point = rp2
                                first_release_adjusted = True
                                log.info(
                                    "Release point from elbow scan at frame %d (3D elbow=%.0f°)",
                                    _bf, _ba,
                                )
                            else:
                                log.warning(
                                    "Elbow scan frame %d also failed: %s — will fallback to first ball detection",
                                    _bf, "; ".join(rp2_fails),
                                )

        point = None
        if best_track_id is not None:
            point = tracks_by_frame.get(fid, {}).get(best_track_id)
            # 只畫出球後的軌跡點：忽略比出球點（或最佳 track 起始幀）更早的 track 點。
            # 優先順序：
            #   1. optimal_release_frame_idx（Pose 多訊號出球幀）— 最準確
            #   2. _best_track_start_fid（SORT best track 起始幀）— 無 Pose 時 fallback
            #   3. _first_ball_frame_for_validation（第一個高信心偵測幀）— 最後退路
            # 這樣可以避免把投手風車動作期間的誤追蹤點或假陽性點畫入軌跡。
            _traj_start = (
                optimal_release_frame_idx if optimal_release_frame_idx is not None
                else _best_track_start_fid if _best_track_start_fid is not None
                else _first_ball_frame_for_validation
            )
            if point is not None and _traj_start is not None and fid < _traj_start:
                point = None
        else:
            dets_list = frame_data["dets_list"]
            if dets_list:
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

                    max_jump = width * 0.25
                    best = None
                    best_cost = 1e18
                    for cx, cy, conf in cand_centers:
                        dist = float(np.hypot(cx - pred[0], cy - pred[1]))
                        if dist > max_jump:
                            continue
                        cost = dist - (conf * 50.0)
                        if cost < best_cost:
                            best_cost = cost
                            best = (cx, cy)
                    point = best

        if point is None:
            pitch_frames.append(FrameInfo(None, False))
            continue

        centerX, centerY = point

        if last_point is not None:
            last_vel = (centerX - last_point[0], centerY - last_point[1])
        last_point = (centerX, centerY)

        if first_ball_frame_idx is None:
            first_ball_frame_idx = fid

        if not first_release_adjusted and fid == first_ball_frame_idx:
            if has_pose:
                rp = _extract_release_point_from_pose(
                    pose_landmarks, image_w=width, image_h=height,
                    throwing_hand=throwing_hand,
                    first_ball_point=(centerX, centerY),
                )
                if rp is not None:
                    rp_valid, rp_fails = _validate_release_point_with_pose(
                        pose_landmarks, rp, throwing_hand,
                        (centerX, centerY), width, height,
                        pose_world_landmarks=pose_world_landmarks,
                    )
                    if rp_valid:
                        release_point = rp
                        log.info("Fallback release point from pose at first ball frame %d (validated)", fid)
                    else:
                        log.warning(
                            "Fallback pose release at frame %d failed validation: %s — "
                            "scanning backward for best elbow frame",
                            fid, "; ".join(rp_fails),
                        )
                        # 往前掃描手肘最伸直的幀（release 應在球偵測到之前）
                        _scan_start = max(0, fid - ELBOW_SCAN_LOOKAHEAD)
                        _bf2, _bp2, _bw2, _ba2 = _find_best_elbow_frame(
                            raw_detections, _scan_start, throwing_hand, end_fid=fid
                        )
                        if _bf2 is not None:
                            rp3 = _extract_release_point_from_pose(
                                _bp2, image_w=width, image_h=height,
                                throwing_hand=throwing_hand,
                                first_ball_point=(centerX, centerY),
                            )
                            if rp3 is not None:
                                rp3_valid, rp3_fails = _validate_release_point_with_pose(
                                    _bp2, rp3, throwing_hand,
                                    (centerX, centerY), width, height,
                                    pose_world_landmarks=_bw2,
                                )
                                if rp3_valid:
                                    release_point = rp3
                                    log.info(
                                        "Fallback release from backward scan at frame %d (3D elbow=%.0f°)",
                                        _bf2, _ba2,
                                    )
                                else:
                                    log.warning(
                                        "Backward scan frame %d also failed: %s — leaving release_point=None",
                                        _bf2, "; ".join(rp3_fails),
                                    )
                else:
                    log.info("No pose release at first ball frame %d, will use trajectory", fid)
            else:
                log.info("No pose at first ball frame %d, will use trajectory", fid)
            first_release_adjusted = True

        # Convert raw-space ball centre to display-space before storing in FrameInfo.
        # The frame stored in FrameInfo is already rotated (display-space), so the
        # ball coordinate must be in the same space for draw_ball_curve to work.
        disp_cx, disp_cy = _raw_to_disp(centerX, centerY)
        # 鮮紅色軌跡（RGB: 255, 30, 30）— generate_overlay 的 frame 為 RGB 格式
        color = (255, 30, 30)
        pitch_frames.append(FrameInfo(None, True, (disp_cx, disp_cy), color))

    # 計算球速
    speed_info = {}
    if speed_calculator and len(pitch_frames) > 0:
        # 提取所有有球的 frame 的座標（限制在飛行結束幀之內）
        _raw_traj = [
            frame.ball for i, frame in enumerate(pitch_frames)
            if frame.ball_in_frame and (flight_end_frame is None or i <= flight_end_frame)
        ]

        # ── 幀間速度過濾：排除相鄰兩點位移過大的跳躍點（SORT 誤追蹤造成的暴衝）──
        # 飛行中棒球每幀最多移動 ~20% 畫面對角線；超過此門檻的點視為異常
        _MAX_JUMP_RATIO = 0.20
        _max_jump_px = float(np.hypot(width, height)) * _MAX_JUMP_RATIO
        ball_trajectory: list = []
        for _pt in _raw_traj:
            if ball_trajectory:
                _prev = ball_trajectory[-1]
                _jump = float(np.hypot(_pt[0] - _prev[0], _pt[1] - _prev[1]))
                if _jump > _max_jump_px:
                    log.warning(
                        "Trajectory outlier skipped: jump=%.0fpx (max=%.0fpx) "
                        "at (%d, %d) from (%d, %d)",
                        _jump, _max_jump_px, _pt[0], _pt[1], _prev[0], _prev[1],
                    )
                    continue
            ball_trajectory.append(_pt)
        
        # ── 用軌跡反推出手點（trajectory-based release point）──
        # Pose 在出手瞬間經常不準（手臂高速 + 動態模糊），
        # 用球的實際飛行軌跡反推更可靠。
        trajectory_release_pt = None
        if best_track_id is not None and best_track_id in tracks_by_id:
            _all_track_items = sorted(
                tracks_by_id[best_track_id], key=lambda x: x["frame_id"]
            )
            # 只用出球點之後的 track 點計算軌跡反推（排除風車動作期的點）
            # 優先順序同軌跡繪製：Pose出球幀 → best track起始幀 → 第一個高信心偵測幀
            _traj_start_for_rp = (
                optimal_release_frame_idx if optimal_release_frame_idx is not None
                else _best_track_start_fid if _best_track_start_fid is not None
                else _first_ball_frame_for_validation
            )
            if _traj_start_for_rp is not None:
                track_items = [t for t in _all_track_items if t["frame_id"] >= _traj_start_for_rp]
            else:
                track_items = _all_track_items
            if len(track_items) >= 2:
                # 用軌跡前段（最多 5 點）估算每幀速度（pixels/frame）
                n_use = min(5, len(track_items))
                t_first = track_items[0]
                t_last = track_items[n_use - 1]
                frame_gap = max(1, t_last["frame_id"] - t_first["frame_id"])
                vx_pf = (t_last["cx"] - t_first["cx"]) / frame_gap
                vy_pf = (t_last["cy"] - t_first["cy"]) / frame_gap

                if (vx_pf * vx_pf + vy_pf * vy_pf) >= 0.5:
                    # 回推幀數（限制在合理範圍）
                    max_back = round(0.10 * fps, 1)  # 最多回推 0.10s
                    if (
                        optimal_release_frame_idx is not None
                        and first_ball_frame_idx is not None
                        and first_ball_frame_idx > optimal_release_frame_idx
                    ):
                        frames_back = min(
                            float(first_ball_frame_idx - optimal_release_frame_idx),
                            max_back,
                        )
                    else:
                        frames_back = max(1.0, round(0.067 * fps, 1))

                    est_x = int(t_first["cx"] - vx_pf * frames_back)
                    est_y = int(t_first["cy"] - vy_pf * frames_back)
                    est_x = max(0, min(width - 1, est_x))
                    est_y = max(0, min(height - 1, est_y))
                    trajectory_release_pt = (est_x, est_y)

        # 若無 track 資料，退回用 ball_trajectory 估算（精度稍差但仍比 pose 穩定）
        if trajectory_release_pt is None and len(ball_trajectory) >= 2:
            p0 = ball_trajectory[0]
            p1 = ball_trajectory[1]
            vx = p1[0] - p0[0]
            vy = p1[1] - p0[1]
            if (vx * vx + vy * vy) >= 4:
                frames_back = max(1.0, round(0.067 * fps, 1))
                est_x = int(p0[0] - vx * frames_back)
                est_y = int(p0[1] - vy * frames_back)
                est_x = max(0, min(width - 1, est_x))
                est_y = max(0, min(height - 1, est_y))
                trajectory_release_pt = (est_x, est_y)

        # ── 嚴格驗證 Pose release point vs 軌跡反推 ──
        # 球的飛行方向（用 best track 的 per-frame 速度，或 ball_trajectory 前兩點）
        ball_flight_dir: Optional[tuple[float, float]] = None
        if best_track_id is not None and best_track_id in tracks_by_id:
            _tk = sorted(tracks_by_id[best_track_id], key=lambda x: x["frame_id"])
            if len(_tk) >= 2:
                _n = min(5, len(_tk))
                _fg = max(1, _tk[_n - 1]["frame_id"] - _tk[0]["frame_id"])
                ball_flight_dir = (
                    (_tk[_n - 1]["cx"] - _tk[0]["cx"]) / _fg,
                    (_tk[_n - 1]["cy"] - _tk[0]["cy"]) / _fg,
                )
        if ball_flight_dir is None and len(ball_trajectory) >= 2:
            ball_flight_dir = (
                float(ball_trajectory[1][0] - ball_trajectory[0][0]),
                float(ball_trajectory[1][1] - ball_trajectory[0][1]),
            )

        if trajectory_release_pt is not None:
            first_ball_pt = ball_trajectory[0] if ball_trajectory else None

            if release_point is None or (
                first_ball_pt is not None and release_point == first_ball_pt
            ):
                # 沒有有效的 Pose release point → 直接用軌跡反推
                release_point = trajectory_release_pt
                log.info(
                    "Release point from trajectory extrapolation: (%d, %d)",
                    trajectory_release_pt[0], trajectory_release_pt[1],
                )
            elif first_ball_pt is not None and ball_flight_dir is not None:
                # Pose release point 存在 → 用三重條件嚴格驗證
                rp_valid, rp_fails = _validate_release_against_trajectory(
                    release_point, trajectory_release_pt,
                    first_ball_pt, ball_flight_dir,
                    width, height,
                )
                if rp_valid:
                    log.info(
                        "Pose release point (%d, %d) passed trajectory validation "
                        "(estimate=(%d, %d))",
                        release_point[0], release_point[1],
                        trajectory_release_pt[0], trajectory_release_pt[1],
                    )
                else:
                    log.warning(
                        "Pose release point (%d, %d) FAILED trajectory validation: "
                        "%s — replacing with trajectory estimate (%d, %d)",
                        release_point[0], release_point[1],
                        "; ".join(rp_fails),
                        trajectory_release_pt[0], trajectory_release_pt[1],
                    )
                    release_point = trajectory_release_pt
            else:
                # 無法驗證（缺少第一顆球或方向）— 保守選擇軌跡反推
                log.info(
                    "Cannot validate pose release, using trajectory estimate (%d, %d)",
                    trajectory_release_pt[0], trajectory_release_pt[1],
                )
                release_point = trajectory_release_pt

        # 找出最後一個有球的 frame index（限制在飛行結束幀之內）
        scan_limit = len(pitch_frames)
        if flight_end_frame is not None:
            scan_limit = min(scan_limit, flight_end_frame + 1)

        last_ball_frame_idx = None
        for i in range(scan_limit - 1, -1, -1):
            if pitch_frames[i].ball_in_frame:
                last_ball_frame_idx = i
                break

        if flight_end_frame is not None and last_ball_frame_idx is not None:
            log.info(
                "Flight range: first_ball=%s, last_ball=%d (flight_end=%d, "
                "original_last=%d, saved %.3fs)",
                first_ball_frame_idx, last_ball_frame_idx, flight_end_frame,
                max(
                    (i for i in range(len(pitch_frames) - 1, -1, -1)
                     if pitch_frames[i].ball_in_frame),
                    default=-1,
                ),
                (max(
                    (i for i in range(len(pitch_frames) - 1, -1, -1)
                     if pitch_frames[i].ball_in_frame),
                    default=last_ball_frame_idx,
                ) - last_ball_frame_idx) / fps,
            )

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

        # Speed timing endpoint: audio/flight-end detection has priority over
        # the last frame where the ball was visually tracked. This lets the
        # speed calculator use the glove-impact time even when YOLO stops early
        # or drifts onto the mitt/hand near the catch.
        speed_end_frame_idx = (
            flight_end_frame
            if flight_end_frame is not None
            else last_ball_frame_idx
        )

        if len(ball_trajectory) >= 2:
            speed_info = speed_calculator.calculate_speed_detailed(
                ball_trajectory,
                release_point=release_point,
                release_frame_idx=optimal_release_frame_idx,
                first_ball_frame_idx=first_ball_frame_idx,
                last_ball_frame_idx=speed_end_frame_idx,
            )
            
            # ── Convert raw-space coords → display-space for overlay drawing ──
            # All bbox/trajectory coordinates are in the raw (YOLO) frame space.
            # The visual frames stored in pitch_frames are already rotated, so
            # any point we embed in speed_info for overlay drawing must also be
            # in the rotated (display) coordinate space.
            def _to_disp(pt):
                if pt is None:
                    return None
                rx, ry = int(pt[0]), int(pt[1])
                if _already_rotated_flag[0]:
                    return (rx, ry)   # already in display space
                if _rotate_code == cv2.ROTATE_90_CLOCKWISE:
                    return (raw_height - 1 - ry, rx)
                if _rotate_code == cv2.ROTATE_90_COUNTERCLOCKWISE:
                    return (ry, raw_width - 1 - rx)
                if _rotate_code == cv2.ROTATE_180:
                    return (raw_width - 1 - rx, raw_height - 1 - ry)
                return (rx, ry)  # no rotation

            # 添加 release_point 到 speed_info 以便在 overlay 中繪製
            # 顯示用的點優先選軌跡第一個偵測點（視覺上最自然）；
            # 若有軌跡反推點則用反推點（更接近真正出手位置）；
            # 最後才 fallback 到 Pose release_point
            # NOTE: trajectory_release_pt and release_point are in RAW space.
            # ball_trajectory is now in DISPLAY space (FrameInfo.ball was converted),
            # so we use the first track point (raw) as the third fallback instead.
            _first_raw_track_pt = None
            if best_track_id is not None and best_track_id in tracks_by_id:
                _sorted_first = sorted(tracks_by_id[best_track_id], key=lambda x: x["frame_id"])
                if _sorted_first:
                    _f = _sorted_first[0]
                    _first_raw_track_pt = (_f["cx"], _f["cy"])
            raw_release_pt = (
                trajectory_release_pt
                if trajectory_release_pt is not None
                else (_first_raw_track_pt if _first_raw_track_pt is not None else release_point)
            )
            if raw_release_pt:
                speed_info['release_point'] = _to_disp(raw_release_pt)

            # ── Catch point: last detected ball position (ignoring flight_end cutoff)
            # ball_trajectory is trimmed at flight_end_frame for speed calc,
            # but the true catch position is the LAST frame the ball was seen
            # in the best track — which may be several frames after flight_end.
            _full_track_pts = []
            if best_track_id is not None and best_track_id in tracks_by_id:
                _full_track_pts = sorted(
                    tracks_by_id[best_track_id], key=lambda x: x["frame_id"]
                )
            if _full_track_pts:
                last_tp = _full_track_pts[-1]
                catch_pt = (last_tp["cx"], last_tp["cy"])   # raw space
                _track_end_fid = last_tp["frame_id"]
            elif best_track_id is not None and best_track_id in tracks_by_id:
                # Fallback: last raw point from tracks_by_id (raw space, consistent)
                _sorted_track = sorted(tracks_by_id[best_track_id], key=lambda x: x["frame_id"])
                if _sorted_track:
                    _tp = _sorted_track[-1]
                    catch_pt = (_tp["cx"], _tp["cy"])   # raw space
                else:
                    catch_pt = None
                _track_end_fid = None
            else:
                catch_pt = None
                _track_end_fid = None

            # ── Trajectory-extrapolation catch point correction ────────────
            # The YOLO tracker often stops before the ball reaches the glove
            # (detection gets unreliable as the ball grows large near the mitt).
            # Extrapolate the ball's trajectory to the catcher's mitt zone.
            if _full_track_pts:
                extrap_pt = _extrapolate_catch_point(
                    _full_track_pts, width, height
                )
                if extrap_pt is not None:
                    _old = catch_pt
                    catch_pt = extrap_pt
                    log.info(
                        "Catch point corrected by extrapolation: (%d,%d) → (%d,%d)  "
                        "Δ=(%.0f,%.0f)px",
                        _old[0] if _old else -1, _old[1] if _old else -1,
                        catch_pt[0], catch_pt[1],
                        catch_pt[0] - (_old[0] if _old else 0),
                        catch_pt[1] - (_old[1] if _old else 0),
                    )

            if catch_pt:
                speed_info['catch_point'] = _to_disp(catch_pt)
                log.info("Catch point recorded: (%d, %d) → disp %s", catch_pt[0], catch_pt[1], speed_info['catch_point'])

            # ── 捕手接球幀 index（供 generate_overlay 做淡入時序）──────
            # 優先用 flight_end_frame（速度演算法偵測到球速陡降的幀），
            # 退路用 _track_end_fid（SORT track 最後一幀）。
            _catch_frame_for_overlay = (
                flight_end_frame
                if flight_end_frame is not None
                else _track_end_fid
            )
            if _catch_frame_for_overlay is not None:
                speed_info['catch_frame_idx'] = int(_catch_frame_for_overlay)
                log.info("Catch frame idx for overlay fade-in: %d", _catch_frame_for_overlay)

            if not manual_strike_zone:
                auto_zone_w, auto_zone_h, _ = _strike_zone_span_from_batter_height(batter_height_m)
                auto_zone = _auto_calibrate_strike_zone(
                    raw_detections=raw_detections,
                    track_points=_full_track_pts,
                    catch_pt=catch_pt,
                    width=disp_width,
                    height=disp_height,
                    zone_w=auto_zone_w,
                    zone_h=auto_zone_h,
                )
                if auto_zone:
                    sz_x_min = float(auto_zone["x_min"])
                    sz_x_max = float(auto_zone["x_max"])
                    sz_y_min = float(auto_zone["y_min"])
                    sz_y_max = float(auto_zone["y_max"])

            # ── Strike zone normalised position ───────────────────────
            # catch_pt is always in DISPLAY space (Phase 1 pre-rotates frames
            # before YOLO, so all bbox / track coords are in display space).
            # STRIKE_ZONE_* constants are defined in display-normalised coords
            # (0-1 within the display frame, portrait orientation for iPhone).
            # No raw↔display conversion is needed here.
            if catch_pt:
                # Normalise catch position to display frame [0-1]
                disp_x_norm = round(catch_pt[0] / disp_width,  4)
                disp_y_norm = round(catch_pt[1] / disp_height, 4)

                # Map into strike-zone coordinate system (0=zone left/top, 1=zone right/bottom)
                sz_w = sz_x_max - sz_x_min
                sz_h = sz_y_max - sz_y_min
                pitch_loc_x = (disp_x_norm - sz_x_min) / sz_w if sz_w > 0 else 0.5
                pitch_loc_y = (disp_y_norm - sz_y_min) / sz_h if sz_h > 0 else 0.5

                def _grid_pos(v: float) -> int:
                    """Map normalised strike-zone coord to 3×3 grid cell index.
                    Returns -1 (outside left/top) or 3 (outside right/bottom) for off-zone balls.
                    """
                    if v < 0:
                        return -1
                    if v > 1:
                        return 3
                    return min(2, int(v * 3))

                speed_info['plate_x_norm']  = disp_x_norm
                speed_info['plate_y_norm']  = disp_y_norm
                speed_info['pitch_loc_x']   = round(pitch_loc_x, 4)
                speed_info['pitch_loc_y']   = round(pitch_loc_y, 4)
                speed_info['is_strike']     = (0.0 <= pitch_loc_x <= 1.0 and 0.0 <= pitch_loc_y <= 1.0)
                speed_info['strike_zone_grid'] = {
                    'col': _grid_pos(pitch_loc_x),
                    'row': _grid_pos(pitch_loc_y),
                }
                # plate_zone bounding box: STRIKE_ZONE_* constants are already in
                # display-normalised coords, so pass them through directly.
                speed_info['plate_zone'] = {
                    'x_min': round(sz_x_min, 4),
                    'x_max': round(sz_x_max, 4),
                    'y_min': round(sz_y_min, 4),
                    'y_max': round(sz_y_max, 4),
                    'source': 'manual' if manual_strike_zone else ('abs_auto' if abs_zone_height_m else 'auto'),
                }
                if abs_zone_height_m is not None:
                    speed_info['batter_height_m'] = round(float(batter_height_m), 3)
                    speed_info['strike_zone_width_cm'] = round(ABS_STRIKE_ZONE_WIDTH_M * 100.0, 2)
                    speed_info['strike_zone_height_cm'] = round(abs_zone_height_m * 100.0, 2)
                    speed_info['strike_zone_rule'] = ABS_STRIKE_ZONE_RULE
                log.info(
                    "Pitch location: catch_disp=(%d,%d) → norm=(%.3f, %.3f)  "
                    "strike_zone=(%.3f, %.3f)  is_strike=%s  grid=col%d/row%d  "
                    "[zone x=%.2f–%.2f  y=%.2f–%.2f]",
                    catch_pt[0], catch_pt[1], disp_x_norm, disp_y_norm,
                    pitch_loc_x, pitch_loc_y, speed_info['is_strike'],
                    speed_info['strike_zone_grid']['col'], speed_info['strike_zone_grid']['row'],
                    sz_x_min, sz_x_max, sz_y_min, sz_y_max,
                )

            # ── RPM estimation ────────────────────────────────────────
            # 優先嘗試光流法（需要球對背景有足夠對比度）；
            # 若光流法信號不足，則以球速推算典型轉速範圍的中位數作為備選估計。
            # 注意：_phase1_rotate 是「實際需要施加的旋轉碼」：
            #   - AVFoundation 已自動旋轉 → _phase1_rotate = None（不再補旋轉）
            #   - cv2 未自動旋轉       → _phase1_rotate = _rotate_code
            spin_rpm = _estimate_spin_rpm(
                video_path, ball_trajectory, fps, width, height,
                best_track_id=best_track_id, tracks_by_id=tracks_by_id,
                rotate_code=_phase1_rotate,
            )

            # 光流法失敗 → 以球速推算（MLB 實測：球速與轉速呈線性相關）
            if spin_rpm is None:
                _speed_kmh = (
                    speed_info.get('release_speed_kmh')
                    or speed_info.get('initial_speed_kmh')
                    or speed_info.get('average_speed_kmh')
                    or 110.0  # 預設值：無法量測球速時，使用業餘投手典型球速
                )
                # 線性回歸近似（MLB 資料）：
                #   ~80 km/h slow pitch  → ~1400 RPM
                #   ~130 km/h fastball   → ~2100 RPM
                #   ~160 km/h fastball   → ~2500 RPM
                # slope ≈ 13.75 RPM/(km/h), intercept ≈ 300 RPM
                spin_rpm = float(np.clip(
                    13.75 * _speed_kmh + 300.0,
                    700.0, 3200.0,
                ))
                spin_rpm = round(spin_rpm / 50.0) * 50.0   # 精度 50 RPM
                speed_info['spin_rpm_estimated'] = True     # 標記為估算值
                log.info(
                    "Spin RPM (speed-based estimate, %.0f km/h): %.0f RPM",
                    _speed_kmh, spin_rpm,
                )

            if spin_rpm is not None:
                speed_info['spin_rpm'] = spin_rpm
                if not speed_info.get('spin_rpm_estimated'):
                    log.info("Spin RPM (optical flow): %.0f RPM", spin_rpm)

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
                        parts.append(f"{label}={kmh:.1f}km/h({kmh_to_mph(kmh):.1f}mph)")
                if speed_info.get('total_distance_m'):
                    parts.append(f"dist={speed_info['total_distance_m']:.2f}m")
                if speed_info.get('num_frames'):
                    parts.append(f"frames={speed_info['num_frames']}")
                if speed_info.get('spin_rpm'):
                    parts.append(f"rpm={speed_info['spin_rpm']:.0f}")
                log.info("Speed results: %s", ", ".join(parts))

    # 補齊少量漏追蹤，讓軌跡更順（若點數不足則函式會直接略過）
    fill_lost_tracking(pitch_frames, fps=fps)

    # ── Sparse trajectory fallback ────────────────────────────────────────────
    # 若 fill_lost_tracking 後可視軌跡點仍太少（< 5），且 best track 有資料，
    # 直接把 best track 的所有原始偵測點補入 pitch_frames，再跑一次插值。
    # 這處理了 SORT 追蹤點只落在少數幀、絕大多數幀 ball_in_frame=False 的情況。
    _n_visible = sum(1 for f in pitch_frames if f.ball_in_frame)
    if _n_visible < 5 and best_track_id is not None and best_track_id in tracks_by_id:
        _bt_all = sorted(tracks_by_id[best_track_id], key=lambda x: x["frame_id"])
        _n_added = 0
        for _item in _bt_all:
            _fi = _item["frame_id"]
            if 0 <= _fi < len(pitch_frames) and not pitch_frames[_fi].ball_in_frame:
                _dcx, _dcy = _raw_to_disp(_item["cx"], _item["cy"])
                pitch_frames[_fi] = FrameInfo(None, True, (_dcx, _dcy), (255, 30, 30))
                _n_added += 1
        if _n_added > 0:
            log.info(
                "Sparse trajectory fallback: added %d raw track points (visible was %d)",
                _n_added, _n_visible,
            )
            # 再跑一次插值，補齊新加入點之間的空隙
            fill_lost_tracking(pitch_frames, fps=fps)

    # ── Sparse fallback (no valid SORT track)：直接用 raw detections ────────────
    # 當 SORT 未能選出有效 track（best_track_id=None）且可視點仍不足時，
    # 把所有通過 Phase 1 過濾器的原始偵測點直接寫入 pitch_frames，
    # 確保偵測極稀疏的影片也能建立最低限度的軌跡。
    _n_visible_notk = sum(1 for f in pitch_frames if f.ball_in_frame)
    if _n_visible_notk < 5 and best_track_id is None:
        _raw_det_added = 0
        for _rd in raw_detections:
            if not _rd.get("dets_list"):
                continue
            _fi = _rd["frame_id"]
            if not (0 <= _fi < len(pitch_frames)) or pitch_frames[_fi].ball_in_frame:
                continue
            _best_dd = max(_rd["dets_list"], key=lambda d: float(d[4]))
            _rcx = int((_best_dd[0] + _best_dd[2]) / 2)
            _rcy = int((_best_dd[1] + _best_dd[3]) / 2)
            _dcx, _dcy = _raw_to_disp(_rcx, _rcy)
            pitch_frames[_fi] = FrameInfo(None, True, (_dcx, _dcy), (255, 30, 30))
            _raw_det_added += 1
        if _raw_det_added > 0:
            log.info(
                "Sparse fallback (no valid SORT track): added %d raw detection points "
                "(visible was %d)",
                _raw_det_added, _n_visible_notk,
            )
            fill_lost_tracking(pitch_frames, fps=fps)

    # ── 第二輪寬容插值：對高幀率或偵測極稀疏的影片再插一次 ────────────────────────
    # 預設 fill_lost_tracking 容忍 0.35s gap。高幀率（如 240fps）影片的偵測點
    # 間隔可能更大（0.5s = 120幀），超出 0.35s 門檻導致仍有明顯空隙。
    # 當可視點 < 8 時，以 max(60幀, fps × 1.0s) 的容忍再跑一次。
    _n_visible_pre_wide = sum(1 for f in pitch_frames if f.ball_in_frame)
    if _n_visible_pre_wide < 8 and fps > 0:
        _wide_gap_frames = max(60, int(fps * 1.0))
        fill_lost_tracking(pitch_frames, fps=0, max_gap_frames=_wide_gap_frames)
        _n_visible_post_wide = sum(1 for f in pitch_frames if f.ball_in_frame)
        if _n_visible_post_wide > _n_visible_pre_wide:
            log.info(
                "Wide-gap fill (max_gap=%d frames, %.2fs at %dfps): %d → %d visible",
                _wide_gap_frames, _wide_gap_frames / fps, fps,
                _n_visible_pre_wide, _n_visible_post_wide,
            )

    # ── Catcher-POV detection ───────────────────────────────────────────────
    # When the camera is behind the catcher, the ball flies straight toward the
    # lens.  x/y pixel displacement is tiny even though the ball travels 18 m,
    # so release_point ≈ catch_point on screen.
    #
    # Detection criterion: use the FULL SPREAD of all ball positions (max - min
    # across all ball frames), NOT just first↔last displacement.  This is robust
    # against SORT track gaps where the first/last recorded frames might not span
    # the true trajectory extent.
    #   • x_spread < 6 % of frame width  AND
    #   • y_spread < 6 % of frame height
    # → ball barely moved laterally on screen → catcher POV
    _ball_pts_for_pov = [f for f in pitch_frames if f.ball_in_frame]
    if len(_ball_pts_for_pov) >= 2:
        _bxs = [f.ball[0] for f in _ball_pts_for_pov]
        _bys = [f.ball[1] for f in _ball_pts_for_pov]
        _x_spread_frac = (max(_bxs) - min(_bxs)) / max(1.0, float(disp_width))
        _y_spread_frac = (max(_bys) - min(_bys)) / max(1.0, float(disp_height))
        speed_info['is_catcher_pov'] = (_x_spread_frac < 0.06 and _y_spread_frac < 0.06)
    else:
        speed_info['is_catcher_pov'] = False

    # 傳遞影片路徑與旋轉碼給 generate_overlay，讓它自行讀幀（省去 Phase 2 重讀影片）
    speed_info['_video_path']   = video_path
    # generate_overlay 需要知道：
    #   _rotate_code      – 影片 metadata 的旋轉碼（來自 ffprobe/exiftool）
    #   _cv2_pre_rotated  – True 表示 Phase 1 的 cv2 已自動旋轉（_phase1_rotate=None）
    # generate_overlay 開新 VideoCapture 時行為可能與 Phase 1 不同，
    # 因此需要原始 _rotate_code 來手動補旋轉。
    speed_info['_rotate_code']      = _rotate_code        # 原始旋轉碼（非 _phase1_rotate）
    speed_info['_cv2_pre_rotated']  = _already_rotated_flag[0]
    speed_info['_raw_detections_pose'] = [
        {
            'frame_id':       rd['frame_id'],
            'has_pose':       rd['has_pose'],
            'pose_landmarks': rd.get('pose_landmarks'),
        }
        for rd in raw_detections
    ]

    # Return the DISPLAY dimensions (after rotation) so that generate_overlay
    # and the VideoWriter receive the correct frame size.
    return pitch_frames, disp_width, disp_height, fps, speed_info
