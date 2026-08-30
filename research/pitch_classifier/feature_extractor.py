"""
PitchFeatureExtractor  —  deeply-optimised version.

Key improvements over the original:
  1. Trajectory is smoothed (moving average, window 3) before measurement to
     suppress detection jitter; endpoints are preserved so the start→end
     reference line stays anchored.
  2. Break is measured both overall AND separately for early (0–40 %) vs late
     (60–100 %) portions of the flight, enabling a "late-break ratio" — the
     most discriminating feature between fastballs and breaking pitches.
  3. Direction-change is computed with proper 360° wrap correction and is only
     meaningful when both halves have non-trivial length.
  4. `trajectory_linearity` falls back to an internally computed R² of a
     least-squares line through the 2-D samples when upstream doesn't supply
     one.
  5. `speed_drop_ratio` uses initial→average relative ratio so it stays
     meaningful for amateur radar that's noisy on absolute km/h.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Dict, List, Optional

import numpy as np

log = logging.getLogger(__name__)

PITCH_LABELS = ["Fastball", "Curveball", "Slider", "Changeup"]
PITCH_UNKNOWN = "Unknown"


@dataclass
class PitchFeatures:
    """單次投球的特徵向量。"""

    # ── 速度 ──
    speed_kmh: float = 0.0
    speed_drop_ratio: float = 0.0   # (initial - average) / initial
    has_reliable_speed: bool = False

    # ── 整體 break（與 start→end 直線的最大偏離，帶符號） ──
    lateral_break: float = 0.0
    vertical_break: float = 0.0     # + = 下落，− = 上飄（影格座標）
    break_magnitude: float = 0.0
    break_angle_deg: float = 0.0

    # ── 時間分段 break（早期 vs 晚期） ──
    early_break_x: float = 0.0
    late_break_x: float = 0.0
    early_break_y: float = 0.0
    late_break_y: float = 0.0
    late_break_ratio: float = 1.0   # late / early；> 1 表示晚破

    # ── 曲率（二次項係數） ──
    curve_coef_x: float = 0.0
    curve_coef_y: float = 0.0

    # ── 方向變化（環繞修正，絕對角度） ──
    direction_change_deg: float = 0.0

    # ── 軌跡線性度（R²，1.0 = 完美直線） ──
    trajectory_linearity: float = 1.0

    # ── 元資料 ──
    video_name: str = ""
    n_trajectory_points: int = 0
    label: str = PITCH_UNKNOWN


class PitchFeatureExtractor:
    """從軌跡和速度資訊提取球種辨識特徵。"""

    def __init__(self, frame_width: int, frame_height: int, fps: int = 120):
        self.frame_width = frame_width
        self.frame_height = frame_height
        self.fps = fps

    # ──────────────────────────────────────────────────────────────────

    def extract(
        self,
        trajectory: List,
        speed_info: Dict,
        video_name: str = "",
    ) -> Optional[PitchFeatures]:
        pts = self._parse_trajectory(trajectory)
        if pts is None or len(pts) < 4:
            log.warning("Trajectory too short: %d points", 0 if pts is None else len(pts))
            return None

        # Smooth to reduce detection noise (endpoints preserved)
        smoothed = self._smooth(pts, window=3)
        n = len(smoothed)
        if n < 4:
            return None

        features = PitchFeatures(video_name=video_name, n_trajectory_points=n)

        # ── Speed ──
        release = speed_info.get("release_speed_kmh") or 0
        initial = speed_info.get("initial_speed_kmh") or 0
        average = speed_info.get("average_speed_kmh") or 0
        features.speed_kmh = float(next((v for v in (release, initial, average) if v and v > 0), 0.0))
        features.has_reliable_speed = 50 <= features.speed_kmh <= 200

        base = initial if initial > 0 else features.speed_kmh
        ref_avg = average if average > 0 else features.speed_kmh
        if base > 1:
            features.speed_drop_ratio = float(max(0.0, (base - ref_avg) / base))

        # ── Normalise to frame (0–1) ──
        xs = smoothed[:, 0] / self.frame_width
        ys = smoothed[:, 1] / self.frame_height
        t = np.linspace(0.0, 1.0, n)

        # ── Overall break: deviation from start→end line ──
        start_x, end_x = xs[0], xs[-1]
        start_y, end_y = ys[0], ys[-1]
        linear_x = start_x + t * (end_x - start_x)
        linear_y = start_y + t * (end_y - start_y)
        dev_x = xs - linear_x
        dev_y = ys - linear_y

        max_x_idx = int(np.argmax(np.abs(dev_x)))
        max_y_idx = int(np.argmax(np.abs(dev_y)))
        features.lateral_break = float(dev_x[max_x_idx])
        features.vertical_break = float(dev_y[max_y_idx])
        features.break_magnitude = float(
            np.sqrt(features.lateral_break ** 2 + features.vertical_break ** 2)
        )
        if abs(features.lateral_break) > 1e-6 or abs(features.vertical_break) > 1e-6:
            features.break_angle_deg = float(
                np.degrees(np.arctan2(features.vertical_break, features.lateral_break))
            )

        # ── Temporal: early (0–40 %) vs late (60–100 %) ──
        early_end = max(2, int(n * 0.40))
        late_start = min(n - 2, int(n * 0.60))
        features.early_break_x = float(np.max(np.abs(dev_x[:early_end])))
        features.early_break_y = float(np.max(np.abs(dev_y[:early_end])))
        if late_start < n:
            features.late_break_x = float(np.max(np.abs(dev_x[late_start:])))
            features.late_break_y = float(np.max(np.abs(dev_y[late_start:])))
        early_total = features.early_break_x + features.early_break_y + 1e-5
        late_total = features.late_break_x + features.late_break_y + 1e-5
        features.late_break_ratio = float(late_total / early_total)

        # ── Curvature ──
        try:
            coef_x = np.polyfit(t, xs, 2)
            coef_y = np.polyfit(t, ys, 2)
            features.curve_coef_x = float(coef_x[0])
            features.curve_coef_y = float(coef_y[0])
        except np.linalg.LinAlgError:
            pass

        # ── Direction change (wrap-corrected) ──
        if n >= 3:
            mid = n // 2
            dx1 = xs[mid] - xs[0]
            dy1 = ys[mid] - ys[0]
            dx2 = xs[-1] - xs[mid]
            dy2 = ys[-1] - ys[mid]
            len1 = float(np.hypot(dx1, dy1))
            len2 = float(np.hypot(dx2, dy2))
            if len1 > 1e-4 and len2 > 1e-4:
                a1 = float(np.degrees(np.arctan2(dy1, dx1)))
                a2 = float(np.degrees(np.arctan2(dy2, dx2)))
                diff = a2 - a1
                while diff > 180:
                    diff -= 360
                while diff < -180:
                    diff += 360
                features.direction_change_deg = float(abs(diff))

        # ── Linearity: prefer upstream, else internal R² ──
        lin = speed_info.get("trajectory_linearity")
        if lin is not None and lin > 0:
            features.trajectory_linearity = float(lin)
        else:
            features.trajectory_linearity = self._linearity_r2(xs, ys)

        return features

    # ──────────────────────────────────────────────────────────────────

    @staticmethod
    def _parse_trajectory(trajectory: List) -> Optional[np.ndarray]:
        if not trajectory:
            return None
        pts = []
        for p in trajectory:
            try:
                if isinstance(p, (tuple, list)) and len(p) >= 2:
                    pts.append((float(p[0]), float(p[1])))
                elif isinstance(p, dict):
                    pts.append((float(p["x"]), float(p["y"])))
                elif hasattr(p, "x") and hasattr(p, "y"):
                    pts.append((float(p.x), float(p.y)))
                else:
                    continue
            except (TypeError, KeyError, ValueError):
                continue
        if len(pts) < 2:
            return None
        return np.array(pts, dtype=float)

    @staticmethod
    def _smooth(pts: np.ndarray, window: int = 3) -> np.ndarray:
        """Moving-average smooth (endpoints preserved)."""
        n = len(pts)
        if n < 3:
            return pts
        half = window // 2
        out = np.empty_like(pts)
        for i in range(n):
            lo = max(0, i - half)
            hi = min(n - 1, i + half)
            out[i] = pts[lo : hi + 1].mean(axis=0)
        out[0] = pts[0]
        out[-1] = pts[-1]
        return out

    @staticmethod
    def _linearity_r2(xs: np.ndarray, ys: np.ndarray) -> float:
        n = len(xs)
        if n < 3:
            return 1.0
        mx, my = float(xs.mean()), float(ys.mean())
        dx = xs - mx
        dy = ys - my
        sxx = float((dx * dx).sum())
        syy = float((dy * dy).sum())
        sxy = float((dx * dy).sum())
        if sxx < 1e-9 or syy < 1e-9:
            return 1.0
        r = sxy / float(np.sqrt(sxx * syy))
        return float(max(0.0, min(1.0, r * r)))

    # ── ML vector dump ────────────────────────────────────────────────

    @staticmethod
    def features_to_vector(features: PitchFeatures) -> np.ndarray:
        return np.array(
            [
                features.speed_kmh,
                features.speed_drop_ratio,
                features.lateral_break,
                features.vertical_break,
                features.break_magnitude,
                features.break_angle_deg,
                features.curve_coef_x,
                features.curve_coef_y,
                features.direction_change_deg,
                features.trajectory_linearity,
                features.early_break_x,
                features.late_break_x,
                features.early_break_y,
                features.late_break_y,
                features.late_break_ratio,
            ],
            dtype=float,
        )

    @staticmethod
    def feature_names() -> List[str]:
        return [
            "speed_kmh",
            "speed_drop_ratio",
            "lateral_break",
            "vertical_break",
            "break_magnitude",
            "break_angle_deg",
            "curve_coef_x",
            "curve_coef_y",
            "direction_change_deg",
            "trajectory_linearity",
            "early_break_x",
            "late_break_x",
            "early_break_y",
            "late_break_y",
            "late_break_ratio",
        ]
