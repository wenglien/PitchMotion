from __future__ import annotations

import cv2
import copy
import numpy as np
from dataclasses import dataclass
from typing import Optional, Tuple, TypedDict


@dataclass
class FrameInfo:
    """Single frame data with optional ball detection info."""

    frame: np.ndarray
    ball_in_frame: bool
    ball: Tuple[int, int] = (0, 0)
    ball_color: Tuple[int, int, int] = (0, 0, 0)
    ball_lost_tracking: bool = False


# ── Shared constants ──────────────────────────────────────────
MS_TO_KMH = 3.6
KMH_TO_MPH = 0.621371
MLB_MOUND_DISTANCE_M = 18.44


def kmh_to_mph(kmh: float) -> float:
    """Convert km/h to mph."""
    return kmh * KMH_TO_MPH


# ── Shared data structures ────────────────────────────────────

class FrameSpeedDetail(TypedDict):
    frame: int
    speed_kmh: float
    speed_ms: float
    distance_m: float
    correction_factor: float


class SpeedInfo(TypedDict, total=False):
    """球速計算結果的結構定義。

    所有 key 都是 optional（total=False）以保持向後相容。
    """
    release_speed_kmh: Optional[float]
    initial_speed_kmh: float
    max_speed_kmh: float
    average_speed_kmh: float
    total_distance_m: float
    effective_distance_m: float
    mound_distance_m: float
    stride_correction_m: float
    flight_time_s: float
    num_frames: int
    frame_details: list[FrameSpeedDetail]
    calculation_method: str
    release_point: tuple[int, int]
    catch_point: tuple[int, int]
    trajectory_linearity: float
    trajectory_quality_warning: bool
    error: str
    # ── Pitch location / Strike Zone (Pitcher POV) ───────────────────
    plate_x_norm: float          # ball landing position normalised to frame width (0-1)
    plate_y_norm: float          # ball landing position normalised to frame height (0-1)
    pitch_loc_x: float           # relative to strike zone: 0=left edge, 1=right edge
    pitch_loc_y: float           # relative to strike zone: 0=top edge, 1=bottom edge
    is_strike: bool              # True if ball crossed inside the strike zone
    strike_zone_grid: dict       # {'col': -1~3, 'row': -1~3}  (0/1/2 = inside zone)
    plate_zone: dict             # {'x_min','x_max','y_min','y_max'} normalised coords


def _catmull_rom_spline(
    points: list[tuple[float, float]],
    num_interp: int = 8,
    alpha: float = 0.5,
) -> list[tuple[int, int]]:
    """Generate smooth curve through control points using Catmull-Rom spline.

    Args:
        points: list of (x, y) control points (at least 2).
        num_interp: number of interpolated points between each pair.
        alpha: 0.0=uniform, 0.5=centripetal (default, avoids cusps), 1.0=chordal.

    Returns:
        list of (int_x, int_y) including original + interpolated points.
    """
    if len(points) < 2:
        return [(int(p[0]), int(p[1])) for p in points]

    # Pad start/end by mirroring to give the spline a tangent at endpoints
    pts = [
        (2 * points[0][0] - points[1][0], 2 * points[0][1] - points[1][1]),
        *points,
        (2 * points[-1][0] - points[-2][0], 2 * points[-1][1] - points[-2][1]),
    ]

    result: list[tuple[int, int]] = []
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i - 1], pts[i], pts[i + 1], pts[i + 2]

        # Knot parameterisation
        def _knot_interval(pa, pb):
            d = ((pa[0] - pb[0]) ** 2 + (pa[1] - pb[1]) ** 2) ** 0.5
            return max(d ** alpha, 1e-6)

        t0 = 0.0
        t1 = t0 + _knot_interval(p0, p1)
        t2 = t1 + _knot_interval(p1, p2)
        t3 = t2 + _knot_interval(p2, p3)

        steps = num_interp if i < len(pts) - 3 else num_interp + 1
        for step in range(steps):
            t = t1 + (t2 - t1) * step / max(1, num_interp)

            a1x = (t1 - t) / (t1 - t0) * p0[0] + (t - t0) / (t1 - t0) * p1[0]
            a1y = (t1 - t) / (t1 - t0) * p0[1] + (t - t0) / (t1 - t0) * p1[1]
            a2x = (t2 - t) / (t2 - t1) * p1[0] + (t - t1) / (t2 - t1) * p2[0]
            a2y = (t2 - t) / (t2 - t1) * p1[1] + (t - t1) / (t2 - t1) * p2[1]
            a3x = (t3 - t) / (t3 - t2) * p2[0] + (t - t2) / (t3 - t2) * p3[0]
            a3y = (t3 - t) / (t3 - t2) * p2[1] + (t - t2) / (t3 - t2) * p3[1]

            b1x = (t2 - t) / (t2 - t0) * a1x + (t - t0) / (t2 - t0) * a2x
            b1y = (t2 - t) / (t2 - t0) * a1y + (t - t0) / (t2 - t0) * a2y
            b2x = (t3 - t) / (t3 - t1) * a2x + (t - t1) / (t3 - t1) * a3x
            b2y = (t3 - t) / (t3 - t1) * a2y + (t - t1) / (t3 - t1) * a3y

            cx = (t2 - t) / (t2 - t1) * b1x + (t - t1) / (t2 - t1) * b2x
            cy = (t2 - t) / (t2 - t1) * b1y + (t - t1) / (t2 - t1) * b2y

            result.append((int(round(cx)), int(round(cy))))

    return result


def draw_ball_curve(
    frame: np.ndarray, trajectory: list, max_points: int | None = 15
) -> np.ndarray:
    """Draw a glowing ball trajectory — no dots, smooth glow line.

    Design:
    - No individual dots: purely a smooth line with additive glow layers.
    - Glow effect: 3 concentric line passes on a dark compositing layer
      (wide soft outer glow → mid glow → bright core → thin white hotline).
    - Tail fades toward older end; head is full brightness.
    - Ball head: bright circle with inner white hotspot, surrounded by glow halo.
    - Scale-aware: all sizes proportional to frame width.
    - Sparse points (low FPS) are smoothed via Catmull-Rom spline interpolation.
    """
    if not trajectory:
        return frame

    # ── tail window ────────────────────────────────────────────────────────
    traj = (
        trajectory[-max_points:]
        if max_points is not None and len(trajectory) > max_points
        else trajectory
    )
    n = len(traj)
    if n == 0:
        return frame

    # ── outlier filter：剔除跳躍偵測點（低畫質影片常見）────────────────────
    # 計算相鄰點間距，距離超過中位數 3 倍的點視為誤偵測並移除。
    # 保留最後一點（最新頭部），以確保球頭始終出現。
    if len(traj) >= 4:
        raw_pts_all = [(float(p[0]), float(p[1])) for p in traj]
        dists = [
            ((raw_pts_all[i][0] - raw_pts_all[i-1][0])**2 +
             (raw_pts_all[i][1] - raw_pts_all[i-1][1])**2) ** 0.5
            for i in range(1, len(raw_pts_all))
        ]
        if dists:
            median_d = float(np.median(dists))
            jump_threshold = max(median_d * 3.0, 40.0)  # 最少 40px 才算跳
            cleaned: list = [traj[0]]
            for i in range(1, len(traj)):
                d = dists[i - 1]
                if d <= jump_threshold:
                    cleaned.append(traj[i])
                # 最後一個點（頭部）強制保留
                elif i == len(traj) - 1:
                    cleaned.append(traj[i])
            if len(cleaned) >= 2:
                traj = cleaned
                n = len(traj)

    # ── parse points & colour ──────────────────────────────────────────────
    # NOTE: frame is in RGB format (generate_overlay converts BGR→RGB).
    raw_color = traj[-1][2]
    if isinstance(raw_color, (list, tuple)) and len(raw_color) >= 3:
        base_r, base_g, base_b = int(raw_color[0]), int(raw_color[1]), int(raw_color[2])
    else:
        base_r, base_g, base_b = 255, 30, 30  # fallback: vivid red (RGB)

    # scale factor: 1.0 at 1080 wide, 2.0 at 2160 wide
    h_fr, w_fr = frame.shape[:2]
    sc = max(0.5, w_fr / 1080.0)

    # ── Spline smoothing for sparse trajectories ───────────────────────────
    # 低 FPS 影片偵測點稀疏（3-8 個），直接連線會產生折線感。
    # 用 Catmull-Rom spline 補出平滑中間點後再畫 glow 線段。
    raw_pts = [(float(p[0]), float(p[1])) for p in traj]
    _SPLINE_THRESHOLD = 12  # 偵測點 ≤ 此值時啟用 spline
    if n >= 3 and n <= _SPLINE_THRESHOLD:
        # 每對點間插 8 個中間點，讓曲線看起來滑順
        pts = _catmull_rom_spline(raw_pts, num_interp=8)
    else:
        pts = [(int(p[0]), int(p[1])) for p in raw_pts]
    n_draw = len(pts)  # spline 後的繪製點數

    if n_draw >= 2:
        # ── 建立兩層獨立 glow 合成層 ────────────────────────────────────────
        # layer1: 寬暈光（模糊發散感） layer2: 銳利核心線
        # 最後兩層都以 screen blending 疊回原始畫面
        glow_layer = np.zeros_like(frame, dtype=np.uint8)

        for i in range(1, n_draw):
            t = i / n_draw       # 0 = 最舊尾端  →  1 = 最新（頭部）
            fade = t ** 0.65     # 亮度曲線：尾端稍暗，頭部全亮

            # 核心線寬（頭部較粗，尾端細）
            core_w = max(3, int((3 + t * 4) * sc))

            # 亮度
            bright = 0.20 + 0.80 * fade   # 尾端 20% → 頭部 100%

            r_full = min(255, int(base_r * bright))
            g_full = min(255, int(base_g * bright))
            b_full = min(255, int(base_b * bright))

            # glow 色（偏白散射光：原色稀釋後加亮底）
            r_glow = min(255, int((base_r * 0.55 + 100) * bright))
            g_glow = min(255, int((base_g * 0.55 +  50) * bright))
            b_glow = min(255, int((base_b * 0.55 +  50) * bright))

            # ① 最外層超寬軟暈（非常低亮度，模擬空氣散射）
            outer_w = max(int(22 * sc), core_w + int(16 * sc))
            cv2.line(glow_layer, pts[i-1], pts[i],
                     (max(0, r_glow // 6), max(0, g_glow // 6), max(0, b_glow // 6)),
                     outer_w, cv2.LINE_AA)

            # ② 中層暈光
            mid_w = max(int(12 * sc), core_w + int(8 * sc))
            cv2.line(glow_layer, pts[i-1], pts[i],
                     (r_glow // 3, g_glow // 3, b_glow // 3),
                     mid_w, cv2.LINE_AA)

            # ③ 內層暈（緊貼核心，稍亮）
            inner_w = max(int(6 * sc), core_w + int(3 * sc))
            cv2.line(glow_layer, pts[i-1], pts[i],
                     (r_glow * 2 // 3, g_glow * 2 // 3, b_glow * 2 // 3),
                     inner_w, cv2.LINE_AA)

            # ④ 亮色核心線
            cv2.line(glow_layer, pts[i-1], pts[i],
                     (r_full, g_full, b_full), core_w, cv2.LINE_AA)

            # ⑤ 細白高光中心線（光澤感，只畫較新段落）
            if fade > 0.35:
                hi_w = max(1, int(1.5 * sc))
                hi_v = int(220 * min(1.0, (fade - 0.35) / 0.65))
                cv2.line(glow_layer, pts[i-1], pts[i],
                         (hi_v, hi_v, hi_v), hi_w, cv2.LINE_AA)

        # ── Additive blending（等效於 screen，無需 float32 轉換）─────────────
        # screen(A,B) ≈ A+B 當 B 接近 0（黑色底），cv2.add 自動飽和 clip 到 255
        frame = cv2.add(frame, glow_layer)

    # ── 球頭：多層發光光暈 + 亮圓 + 白色高光點 ─────────────────────────────
    if pts:
        head = pts[-1]
        head_r = max(8, int(11 * sc))

        head_glow = np.zeros_like(frame, dtype=np.uint8)

        # 最外層大光暈（大半徑，中等亮度——在亮色背景下也可見）
        halo_r3 = head_r + max(16, int(24 * sc))
        cv2.circle(head_glow, head, halo_r3,
                   (min(255, base_r // 4), min(255, base_g // 4), min(255, base_b // 4)),
                   -1, cv2.LINE_AA)

        # 中外層光暈（較亮）
        halo_r2 = head_r + max(9, int(14 * sc))
        cv2.circle(head_glow, head, halo_r2,
                   (min(255, base_r // 2), min(255, base_g // 2), min(255, base_b // 2)),
                   -1, cv2.LINE_AA)

        # 內層光暈（緊貼核心，全亮）
        halo_r1 = head_r + max(4, int(6 * sc))
        cv2.circle(head_glow, head, halo_r1,
                   (min(255, base_r * 3 // 4 + 40),
                    min(255, base_g * 3 // 4 + 15),
                    min(255, base_b * 3 // 4 + 15)), -1, cv2.LINE_AA)

        # 核心亮圓（黑色邊框確保與背景分離）
        cv2.circle(head_glow, head, head_r + max(2, int(3 * sc)), (0, 0, 0), -1, cv2.LINE_AA)
        cv2.circle(head_glow, head, head_r, (base_r, base_g, base_b), -1, cv2.LINE_AA)

        # 白色高光點（3D 光澤感）
        hot_r   = max(3, int(4 * sc))
        hot_off = max(1, int(2 * sc))
        cv2.circle(head_glow, (head[0] - hot_off, head[1] - hot_off),
                   hot_r, (255, 255, 255), -1, cv2.LINE_AA)

        # Additive blend 頭部光暈（與軌跡線相同方式，避免 float32 轉換）
        frame = cv2.add(frame, head_glow)

    return frame


def _remove_outliers(x_data: list, y_data: list) -> tuple[list, list]:
    """Remove outlier points using median velocity filtering (3x median threshold)."""
    if len(x_data) < 5:
        return x_data, y_data

    # Compute inter-point velocities once
    velocities = [abs(x_data[i] - x_data[i - 1]) for i in range(1, len(x_data))]
    if not velocities:
        return x_data, y_data

    median_vel = np.median(velocities)
    threshold = median_vel * 3.0

    clean_x, clean_y = [x_data[0]], [y_data[0]]
    for i in range(1, len(x_data)):
        if velocities[i - 1] <= threshold:
            clean_x.append(x_data[i])
            clean_y.append(y_data[i])

    return clean_x, clean_y


def fill_lost_tracking(
    frame_list: list[FrameInfo],
    max_gap_frames: int = 30,
    fps: int = 0,
) -> None:
    """Interpolate missing ball positions using time-series polynomial fitting.

    Scans for gaps between detected frames (ball_in_frame=True) and fills them
    using separate polynomial fits for cx(t) and cy(t) over frame index t.
    This is robust to near-vertical trajectories where the old X→Y polyfit failed.

    Args:
        frame_list: list of FrameInfo objects (mutated in-place).
        max_gap_frames: gaps longer than this are not interpolated (default 30).
        fps: video FPS; when > 0, max_gap_frames is auto-scaled for low-FPS videos
             (base reference: 120fps → 30 frames gap ≈ 0.25s).
    """
    # ── FPS-adaptive gap tolerance ──────────────────────────────────────────
    # 低 FPS 下偵測間隔更大（30fps 只有 12-15 幀飛行，gap 3 幀 = 0.1s），
    # 用固定 max_gap=30 會正常，但 max_gap=30 對 30fps 其實是 1 秒——太寬鬆。
    # 改為以時間為基準：允許最多 ~0.35s 的 gap。
    if fps > 0:
        max_gap_seconds = 0.35
        max_gap_frames = max(5, int(fps * max_gap_seconds))
    # Collect (frame_idx, cx, cy) for all detected frames
    detected: list[tuple[int, int, int]] = [
        (idx, frame.ball[0], frame.ball[1])
        for idx, frame in enumerate(frame_list)
        if frame.ball_in_frame
    ]

    if len(detected) < 2:
        return

    idxs = np.array([d[0] for d in detected], dtype=float)
    cxs  = np.array([d[1] for d in detected], dtype=float)
    cys  = np.array([d[2] for d in detected], dtype=float)

    # Outlier removal on detections before fitting
    if len(detected) >= 4:
        _cx_list = cxs.tolist()
        _cy_list = cys.tolist()
        _idx_list = idxs.tolist()
        # Filter by velocity: remove points where inter-point distance > 3× median
        _dists = [
            ((cxs[i] - cxs[i - 1]) ** 2 + (cys[i] - cys[i - 1]) ** 2) ** 0.5
            for i in range(1, len(detected))
        ]
        if _dists:
            _med_d = float(np.median(_dists))
            _thresh = max(_med_d * 3.0, 30.0)
            _keep_cx, _keep_cy, _keep_idx = [_cx_list[0]], [_cy_list[0]], [_idx_list[0]]
            for i in range(1, len(detected)):
                if _dists[i - 1] <= _thresh:
                    _keep_cx.append(_cx_list[i])
                    _keep_cy.append(_cy_list[i])
                    _keep_idx.append(_idx_list[i])
            if len(_keep_idx) >= 2:
                idxs = np.array(_keep_idx, dtype=float)
                cxs  = np.array(_keep_cx, dtype=float)
                cys  = np.array(_keep_cy, dtype=float)

    if len(idxs) < 2:
        return

    # Fit polynomials: degree 2 when ≥ 3 points, degree 1 (linear) otherwise
    deg = min(2, len(idxs) - 1)
    try:
        cx_coeffs = np.polyfit(idxs, cxs, deg)
        cy_coeffs = np.polyfit(idxs, cys, deg)
    except Exception:
        return

    # Build a set of frame indices that already have detections
    detected_set: set[int] = {d[0] for d in detected}
    detected_sorted_idxs = sorted(detected_set)

    # Colour of the most recent detection (used for gap frames)
    _color_map: dict[int, tuple] = {
        idx: frame.ball_color
        for idx, frame in enumerate(frame_list)
        if frame.ball_in_frame
    }

    # Find consecutive pairs of detected frames and fill gaps between them
    for i in range(len(detected_sorted_idxs) - 1):
        prev_fid = detected_sorted_idxs[i]
        next_fid = detected_sorted_idxs[i + 1]
        gap_len = next_fid - prev_fid - 1
        if gap_len <= 0 or gap_len > max_gap_frames:
            continue  # no gap or gap too large

        color = _color_map.get(prev_fid, (255, 30, 30))
        for gap_fid in range(prev_fid + 1, next_fid):
            if gap_fid in detected_set:
                continue  # already has detection
            t = float(gap_fid)
            est_cx = int(round(float(np.polyval(cx_coeffs, t))))
            est_cy = int(round(float(np.polyval(cy_coeffs, t))))
            frame_list[gap_fid].ball_in_frame = True
            frame_list[gap_fid].ball = (est_cx, est_cy)
            frame_list[gap_fid].ball_color = color


def distance(x: tuple, y: tuple) -> float:
    """Euclidean distance between two 2D points."""
    return float(np.hypot(x[0] - y[0], x[1] - y[1]))
