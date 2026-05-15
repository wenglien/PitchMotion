from __future__ import annotations

import logging
import numpy as np
from typing import List, Tuple, Optional, Dict

from src.utils import MS_TO_KMH, SpeedInfo

log = logging.getLogger(__name__)

PERSPECTIVE_NEAR_FACTOR = 1.15   # Correction factor at near-y
PERSPECTIVE_RANGE = 0.30         # Drop across the near→far range

# 棒球飛行阻力係數（公式：a = -k * v²，k ≈ 0.0024 s/m，來自棒球氣動力學研究）
# 在 effective_dist=16.74m 的典型投球中，120 km/h 的球到本壘板約減速 5-8 km/h
AIR_RESISTANCE_K = 0.0024        # 阻力係數（s/m），v² 比例衰減
AIR_RESISTANCE_DECAY = 0.01      # 保留舊常數（pixel-based mode 仍使用）

MAX_REASONABLE_SPEED_KMH = 200   # 合理球速上限 (km/h)，原 250 偏高
RELEASE_FALLBACK_SEC = 0.25      # Conservative release→first-detect interval (~30 frames @ 120fps)
MAX_PRE_DETECT_SEC = 0.50        # Pre-detection cap（release→first ball）
                                  # 120fps 下最多允許 60 幀的 gap（pose 提早偵測→YOLO 才看到球）
MIN_PIXEL_DIST = 10              # Minimum pixel distance for release calc
DEFAULT_STRIDE_CORRECTION = 1.7  # MLB avg stride + arm extension (~5.6 ft)
MIN_FLIGHT_TIME_SEC = 0.25       # 投球飛行至少 0.25s，防止時間過小球速暴衝
MIN_REASONABLE_SPEED_MS = 20.0   # ~72 km/h，含業餘投手（放寬下限，減少 clamp 影響）
MAX_REASONABLE_SPEED_MS = 47.0   # ~169 km/h，職棒頂尖最高合理速度


class BallSpeedCalculator:
    """Compute ball speed from trajectory data with optional perspective correction."""

    def __init__(
        self,
        fps: int,
        video_width: int,
        video_height: int,
        pixels_per_meter: Optional[float] = None,
        theoretical_distance: Optional[float] = None,
        stride_correction: Optional[float] = None,
    ):
        if fps <= 0:
            raise ValueError(f"fps must be positive, got {fps}")
        self.fps = fps
        self.video_width = video_width
        self.video_height = video_height
        self.pixels_per_meter = pixels_per_meter
        self.perspective_matrix = None
        self.near_y: Optional[int] = None
        self.far_y: Optional[int] = None
        self.theoretical_distance = theoretical_distance
        self.stride_correction = (
            stride_correction if stride_correction is not None
            else DEFAULT_STRIDE_CORRECTION
        )

    @property
    def effective_distance(self) -> Optional[float]:
        """實際球飛行距離 = 投手丘距離 - 跨步修正。"""
        if self.theoretical_distance is None:
            return None
        eff = self.theoretical_distance - self.stride_correction
        return max(eff, 1.0)  # 保底 1m，避免極端值

    # ── Calibration ────────────────────────────────────────────

    def calibrate_from_reference(
        self,
        pitcher_mound_pixel: Tuple[int, int],
        home_plate_pixel: Tuple[int, int],
        real_distance: float = 18.44,
    ) -> None:
        """Calibrate pixels_per_meter from two known reference points."""
        pixel_distance = float(np.hypot(
            home_plate_pixel[0] - pitcher_mound_pixel[0],
            home_plate_pixel[1] - pitcher_mound_pixel[1],
        ))
        self.pixels_per_meter = pixel_distance / real_distance
        self._calculate_perspective_factors(pitcher_mound_pixel, home_plate_pixel)
        log.info("Calibration done: %.2f px/m", self.pixels_per_meter)

    def _calculate_perspective_factors(
        self, near_point: Tuple[int, int], far_point: Tuple[int, int]
    ) -> None:
        self.near_y = min(near_point[1], far_point[1])
        self.far_y = max(near_point[1], far_point[1])

    def _apply_perspective_correction(self, point: Tuple[int, int]) -> float:
        """Return perspective correction factor based on Y-coordinate."""
        if self.near_y is None or self.far_y is None or self.far_y == self.near_y:
            return 1.0
        t = float(np.clip((point[1] - self.near_y) / (self.far_y - self.near_y), 0, 1))
        return PERSPECTIVE_NEAR_FACTOR - (PERSPECTIVE_RANGE * t)

    # ── Frame-elapsed estimation ───────────────────────────────

    def _estimate_frames_elapsed(
        self,
        release_frame_idx: Optional[int],
        first_ball_frame_idx: Optional[int],
    ) -> float:
        fallback = max(1.0, round(RELEASE_FALLBACK_SEC * self.fps, 1))
        max_pre_frames = max(1.0, round(MAX_PRE_DETECT_SEC * self.fps, 1))

        if (
            release_frame_idx is not None
            and first_ball_frame_idx is not None
            and first_ball_frame_idx > release_frame_idx
        ):
            raw = float(max(1, first_ball_frame_idx - release_frame_idx))
            if raw > max_pre_frames:
                log.warning(
                    "Pre-detect gap %.0f frames (%.3fs) exceeds cap %.0f frames (%.3fs), "
                    "using fallback %.0f frames (%.3fs) — release detection may be too early",
                    raw, raw / self.fps, max_pre_frames, MAX_PRE_DETECT_SEC,
                    fallback, fallback / self.fps,
                )
                return fallback
            # A pose release that lands too close to first ball detection makes
            # flight time too short and inflates speed. Use pose as a lower
            # bound only; keep a conservative minimum pre-detect compensation.
            return max(raw, fallback)
        return fallback

    # ── Release speed ──────────────────────────────────────────

    def calculate_release_speed(
        self,
        release_point: Tuple[int, int],
        first_ball_point: Tuple[int, int],
        frames_elapsed: float = 2.5,
    ) -> Optional[float]:
        """Calculate release speed (km/h) from release point to first detection."""
        if self.pixels_per_meter is None:
            return None

        pixel_dist = float(np.hypot(
            first_ball_point[0] - release_point[0],
            first_ball_point[1] - release_point[1],
        ))

        if pixel_dist < MIN_PIXEL_DIST or pixel_dist > self.video_width / 2:
            return None

        mid_y = int((release_point[1] + first_ball_point[1]) / 2)
        correction = self._apply_perspective_correction((0, mid_y))
        real_dist = (pixel_dist / self.pixels_per_meter) * correction
        time = frames_elapsed / self.fps
        speed_kmh = (real_dist / time) * MS_TO_KMH

        if speed_kmh > MAX_REASONABLE_SPEED_KMH:
            log.warning("Release speed %.1f km/h exceeds cap, discarding", speed_kmh)
            return None
        return speed_kmh

    # ── Detailed speed computation ─────────────────────────────

    def calculate_speed_detailed(
        self,
        trajectory_points: List[Tuple[int, int]],
        release_point: Optional[Tuple[int, int]] = None,
        release_frame_idx: Optional[int] = None,
        first_ball_frame_idx: Optional[int] = None,
        last_ball_frame_idx: Optional[int] = None,
    ) -> SpeedInfo:
        """Return comprehensive speed breakdown dict."""
        if len(trajectory_points) < 2:
            return {"error": "Not enough trajectory points (need >= 2)"}

        # ── Theoretical mode ───────────────────────────────────
        if self.theoretical_distance is not None:
            return self._calculate_theoretical(
                trajectory_points, release_point,
                release_frame_idx, first_ball_frame_idx,
                last_ball_frame_idx,
            )

        # ── Pixel-based mode ──────────────────────────────────
        if self.pixels_per_meter is None:
            return {"error": "Missing distance info: provide theoretical_distance or run calibrate_from_reference"}

        return self._calculate_pixel_based(
            trajectory_points, release_point,
            release_frame_idx, first_ball_frame_idx,
        )

    # ── Trajectory quality ─────────────────────────────────────────

    def _compute_trajectory_linearity(
        self,
        trajectory_points: List[Tuple[int, int]],
    ) -> float:
        """計算軌跡的直線性指標（normalized RMSE）。

        對軌跡點做線性迴歸，回傳偏差 RMSE 除以畫面對角線長度的比值（0~1）。
        越接近 0 代表軌跡越直、越可靠；越接近 1 代表軌跡越彎曲或雜訊越多。
        """
        if len(trajectory_points) < 3:
            return 0.0

        xs = np.array([p[0] for p in trajectory_points], dtype=float)
        ys = np.array([p[1] for p in trajectory_points], dtype=float)
        t = np.arange(len(xs), dtype=float)

        cx = np.polyfit(t, xs, 1)
        cy = np.polyfit(t, ys, 1)
        x_pred = np.polyval(cx, t)
        y_pred = np.polyval(cy, t)

        residuals = np.sqrt((xs - x_pred) ** 2 + (ys - y_pred) ** 2)
        rmse = float(np.sqrt(np.mean(residuals ** 2)))

        diag = float(np.hypot(self.video_width, self.video_height))
        linearity = rmse / (diag + 1e-6)
        return round(linearity, 4)

    # ── Private helpers ────────────────────────────────────────

    def _estimate_flight_time(
        self,
        num_trajectory_points: int,
        release_frame_idx: Optional[int],
        first_ball_frame_idx: Optional[int],
        last_ball_frame_idx: Optional[int],
    ) -> float:
        """估算完整飛行時間（秒）。

        優先用偵測區間（first→last），避免 release 偵測太早拉長時間：
        1. first_ball → last_ball + 補回 pre-detect 時間
        2. release → last_ball（僅上面不可用時）
        3. num_trajectory_points / fps（最後退路）
        """
        raw_time = None

        # 優先：用實際偵測到球的區間
        if (
            first_ball_frame_idx is not None
            and last_ball_frame_idx is not None
            and last_ball_frame_idx > first_ball_frame_idx
        ):
            detection_frames = float(last_ball_frame_idx - first_ball_frame_idx)
            pre_frames = self._estimate_frames_elapsed(
                release_frame_idx, first_ball_frame_idx
            )
            total_frames = detection_frames + pre_frames
            log.info(
                "Flight time: first(%d)→last(%d)=%d + pre=%.1f → %.1f frames (%.3fs)",
                first_ball_frame_idx, last_ball_frame_idx,
                int(detection_frames), pre_frames, total_frames,
                total_frames / self.fps,
            )
            raw_time = max(1.0, total_frames) / self.fps

        # 退路：用 release → last
        if raw_time is None and (
            release_frame_idx is not None
            and last_ball_frame_idx is not None
            and last_ball_frame_idx > release_frame_idx
        ):
            flight_frames = float(last_ball_frame_idx - release_frame_idx)
            log.info(
                "Flight time fallback: release(%d)→last(%d) = %d frames (%.3fs)",
                release_frame_idx, last_ball_frame_idx,
                int(flight_frames), flight_frames / self.fps,
            )
            raw_time = max(1.0, flight_frames) / self.fps

        # 最後退路
        if raw_time is None:
            log.info(
                "Flight time last-resort: %d trajectory points / %d fps",
                num_trajectory_points, self.fps,
            )
            raw_time = max(1, num_trajectory_points) / self.fps

        # 防止時間過小 → 球速暴衝
        if raw_time < MIN_FLIGHT_TIME_SEC:
            log.warning(
                "Flight time %.3fs < min %.2fs, clamping",
                raw_time, MIN_FLIGHT_TIME_SEC,
            )
            raw_time = MIN_FLIGHT_TIME_SEC

        # 雙邊 physics clamp：根據有效距離限制飛行時間在物理合理範圍內
        # - 上限：有效距離 / MIN_REASONABLE_SPEED_MS（最慢合理速度）
        # - 下限：有效距離 / MAX_REASONABLE_SPEED_MS（最快合理速度）
        if self.effective_distance is not None:
            max_flight_time = self.effective_distance / MIN_REASONABLE_SPEED_MS
            min_flight_time = self.effective_distance / MAX_REASONABLE_SPEED_MS

            if raw_time > max_flight_time:
                log.warning(
                    "Flight time %.3fs exceeds physics ceiling %.3fs "
                    "(effective_dist=%.2fm, min_speed=%.1f m/s ≈ %.0f km/h), clamping",
                    raw_time, max_flight_time,
                    self.effective_distance, MIN_REASONABLE_SPEED_MS,
                    MIN_REASONABLE_SPEED_MS * MS_TO_KMH,
                )
                raw_time = max_flight_time
            elif raw_time < min_flight_time:
                log.warning(
                    "Flight time %.3fs below physics floor %.3fs "
                    "(effective_dist=%.2fm, max_speed=%.1f m/s ≈ %.0f km/h), clamping",
                    raw_time, min_flight_time,
                    self.effective_distance, MAX_REASONABLE_SPEED_MS,
                    MAX_REASONABLE_SPEED_MS * MS_TO_KMH,
                )
                raw_time = min_flight_time

        return raw_time

    def _calculate_theoretical(
        self,
        trajectory_points: List[Tuple[int, int]],
        release_point: Optional[Tuple[int, int]],
        release_frame_idx: Optional[int],
        first_ball_frame_idx: Optional[int],
        last_ball_frame_idx: Optional[int] = None,
    ) -> SpeedInfo:
        num_frames = len(trajectory_points)
        distance = self.effective_distance
        log.info(
            "Theoretical calc: mound=%.2fm, stride_corr=%.2fm, effective=%.2fm",
            self.theoretical_distance, self.stride_correction, distance,
        )

        total_time = self._estimate_flight_time(
            num_frames, release_frame_idx, first_ball_frame_idx, last_ball_frame_idx,
        )
        log.info("Flight time: %.3fs (%d fps)", total_time, self.fps)

        avg_speed_ms = distance / total_time
        avg_speed_kmh = avg_speed_ms * MS_TO_KMH

        # ── 真實物理：用空氣阻力反推出手球速 ────────────────────────────
        # 空氣阻力：dv/dt = -k * v²（k = AIR_RESISTANCE_K）
        # 解析解：v(t) = v0 / (1 + k * v0 * t)
        # 已知：avg_speed（飛行平均速度）= distance / total_time
        # 求：v0（出手球速，初速）
        #
        # 數值方法：對 v0 做簡單二分搜尋（50 次迭代，精度 <0.01 km/h）
        k = AIR_RESISTANCE_K
        def _simulate_avg_speed(v0_ms: float) -> float:
            """給定初速 v0（m/s），模擬整段飛行，回傳平均速度（m/s）。"""
            dt = total_time / 200  # 細分 200 步
            v = v0_ms
            total_dist = 0.0
            for _ in range(200):
                total_dist += v * dt
                v = v / (1.0 + k * v * dt)
            return total_dist / total_time

        # 二分搜尋 v0：使 simulate_avg_speed(v0) ≈ avg_speed_ms
        lo, hi = avg_speed_ms, avg_speed_ms * 1.20  # v0 一定 > avg
        for _ in range(60):
            mid = (lo + hi) / 2.0
            if _simulate_avg_speed(mid) > avg_speed_ms:
                hi = mid
            else:
                lo = mid
        release_speed_ms = (lo + hi) / 2.0
        release_speed_kmh = release_speed_ms * MS_TO_KMH

        # 球速護欄
        if release_speed_kmh > MAX_REASONABLE_SPEED_KMH:
            log.warning(
                "Release speed %.1f km/h exceeds cap (%.0f), clamping",
                release_speed_kmh, MAX_REASONABLE_SPEED_KMH,
            )
            release_speed_kmh = float(MAX_REASONABLE_SPEED_KMH)
            release_speed_ms = release_speed_kmh / MS_TO_KMH

        log.info(
            "Speed calc: avg=%.1f km/h, release(v0)=%.1f km/h "
            "(air_resist_k=%.4f, flight_time=%.3fs, dist=%.2fm)",
            avg_speed_kmh, release_speed_kmh,
            k, total_time, distance,
        )

        # ── 每幀速度剖面（v² 衰減） ────────────────────────────────────
        dt_frame = 1.0 / self.fps
        dist_per_frame = distance / max(1, num_frames)
        v = release_speed_ms
        synthetic_details = []
        for i in range(num_frames):
            synthetic_details.append({
                'frame': i,
                'speed_kmh': v * MS_TO_KMH,
                'speed_ms': v,
                'distance_m': dist_per_frame,
                'correction_factor': 1.0,
            })
            v = max(0.0, v / (1.0 + k * v * dt_frame))

        pixel_release_speed = None
        if self.pixels_per_meter is not None and release_point and trajectory_points:
            fe = self._estimate_frames_elapsed(release_frame_idx, first_ball_frame_idx)
            pixel_release_speed = self.calculate_release_speed(
                release_point, trajectory_points[0], frames_elapsed=fe
            )

        linearity = self._compute_trajectory_linearity(trajectory_points)
        quality_warning = linearity > 0.03
        if quality_warning:
            log.warning(
                "Trajectory linearity RMSE=%.4f (>3%% of diagonal) — "
                "possible tracking noise affecting speed accuracy",
                linearity,
            )
        else:
            log.info("Trajectory linearity RMSE=%.4f (OK)", linearity)

        return {
            'release_speed_kmh': release_speed_kmh,       # 出手球速（物理反推初速）
            'initial_speed_kmh': release_speed_kmh,        # 同 release_speed（供 UI 顯示）
            'max_speed_kmh': release_speed_kmh,             # 最大速度即出手時速度
            'average_speed_kmh': avg_speed_kmh,             # 平均速度（distance/time）
            'pixel_release_speed_kmh': pixel_release_speed, # 像素模式推算出手速（有校準時才有）
            'total_distance_m': distance,
            'effective_distance_m': distance,
            'mound_distance_m': self.theoretical_distance,
            'stride_correction_m': self.stride_correction,
            'flight_time_s': total_time,
            'num_frames': num_frames,
            'frame_details': synthetic_details,
            'trajectory_linearity': linearity,
            'trajectory_quality_warning': quality_warning,
            'calculation_method': 'theoretical',
        }

    def _calculate_pixel_based(
        self,
        trajectory_points: List[Tuple[int, int]],
        release_point: Optional[Tuple[int, int]],
        release_frame_idx: Optional[int],
        first_ball_frame_idx: Optional[int],
    ) -> SpeedInfo:
        time_interval = 1.0 / self.fps
        speeds = []

        for i in range(len(trajectory_points) - 1):
            p1, p2 = trajectory_points[i], trajectory_points[i + 1]
            pixel_dist = float(np.hypot(p2[0] - p1[0], p2[1] - p1[1]))
            mid_y = int((p1[1] + p2[1]) / 2)
            correction = self._apply_perspective_correction((0, mid_y))
            real_dist = (pixel_dist / self.pixels_per_meter) * correction
            speed_ms = real_dist / time_interval

            speeds.append({
                'frame': i,
                'speed_kmh': speed_ms * MS_TO_KMH,
                'speed_ms': speed_ms,
                'distance_m': real_dist,
                'correction_factor': correction,
            })

        release_speed = None
        if release_point and trajectory_points:
            fe = self._estimate_frames_elapsed(release_frame_idx, first_ball_frame_idx)
            release_speed = self.calculate_release_speed(
                release_point, trajectory_points[0], frames_elapsed=fe
            )

        speed_values = [s['speed_kmh'] for s in speeds]

        # 使用中位數/percentile 取代 mean/max，抵抗異常幀污染
        # initial_speed：前 10% 軌跡點的中位數（至少 3 點）
        n_initial = max(3, len(speed_values) // 10)
        initial_speeds = speed_values[:n_initial]

        linearity = self._compute_trajectory_linearity(trajectory_points)
        quality_warning = linearity > 0.05
        if quality_warning:
            log.warning(
                "Trajectory linearity RMSE=%.4f (>5%% of diagonal) — "
                "possible tracking noise affecting speed accuracy",
                linearity,
            )
        else:
            log.info("Trajectory linearity RMSE=%.4f (OK)", linearity)

        return {
            'release_speed_kmh': release_speed,
            'initial_speed_kmh': float(np.median(initial_speeds)) if initial_speeds else 0,
            'max_speed_kmh': float(np.percentile(speed_values, 95)) if speed_values else 0,
            'average_speed_kmh': float(np.median(speed_values)) if speed_values else 0,
            'total_distance_m': sum(s['distance_m'] for s in speeds),
            'num_frames': len(trajectory_points),
            'frame_details': speeds,
            'trajectory_linearity': linearity,
            'trajectory_quality_warning': quality_warning,
            'calculation_method': 'pixel_based',
        }
