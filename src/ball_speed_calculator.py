from __future__ import annotations

import logging
import numpy as np
from typing import List, Tuple, Optional, Dict

from src.utils import MS_TO_KMH, SpeedInfo

log = logging.getLogger(__name__)

# ── Tunable Constants ──────────────────────────────────────────
PERSPECTIVE_NEAR_FACTOR = 1.15   # Correction factor at near-y
PERSPECTIVE_RANGE = 0.30         # Drop across the near→far range
AIR_RESISTANCE_DECAY = 0.01     # Synthetic per-frame speed decay (km/h)
INITIAL_SPEED_MULT = 1.10       # Theoretical initial-speed multiplier
MAX_SPEED_MULT = 1.15           # Theoretical max-speed multiplier
MAX_REASONABLE_SPEED_KMH = 250  # Sanity cap for release speed
RELEASE_FALLBACK_SEC = 0.067    # Default release→first-detect interval
MAX_PRE_DETECT_SEC = 0.10       # Pre-detection （release→first ball）
MIN_PIXEL_DIST = 10             # Minimum pixel distance for release calc
DEFAULT_STRIDE_CORRECTION = 1.7  # MLB avg stride + arm extension (~5.6 ft)
MIN_FLIGHT_TIME_SEC = 0.25       # 投球飛行至少 ~0.35s，設 0.25 防止時間過小球速暴衝
MIN_REASONABLE_SPEED_MS = 22.2   # ~80 km/h (~50 mph)，任何真實投球都不會低於此速


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
            return raw
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

        # 防止時間過大 → 球速偏低（球被追蹤超過本壘板）
        if self.effective_distance is not None:
            max_flight_time = self.effective_distance / MIN_REASONABLE_SPEED_MS
            if raw_time > max_flight_time:
                log.warning(
                    "Flight time %.3fs exceeds physics ceiling %.3fs "
                    "(effective_dist=%.2fm, min_speed=%.1f m/s ≈ %.0f km/h), clamping",
                    raw_time, max_flight_time,
                    self.effective_distance, MIN_REASONABLE_SPEED_MS,
                    MIN_REASONABLE_SPEED_MS * MS_TO_KMH,
                )
                raw_time = max_flight_time

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
        initial_speed = avg_speed_kmh * INITIAL_SPEED_MULT
        max_speed = avg_speed_kmh * MAX_SPEED_MULT

        # 球速上限護欄
        if avg_speed_kmh > MAX_REASONABLE_SPEED_KMH:
            log.warning(
                "Average speed %.1f km/h exceeds cap (%.0f), clamping",
                avg_speed_kmh, MAX_REASONABLE_SPEED_KMH,
            )
            avg_speed_kmh = float(MAX_REASONABLE_SPEED_KMH)
            initial_speed = min(initial_speed, float(MAX_REASONABLE_SPEED_KMH))
            max_speed = min(max_speed, float(MAX_REASONABLE_SPEED_KMH))

        release_speed = None
        if self.pixels_per_meter is not None and release_point and trajectory_points:
            fe = self._estimate_frames_elapsed(release_frame_idx, first_ball_frame_idx)
            release_speed = self.calculate_release_speed(
                release_point, trajectory_points[0], frames_elapsed=fe
            )

        dist_per_frame = avg_speed_ms / self.fps
        current_speed = initial_speed
        synthetic_details = []
        for i in range(num_frames):
            synthetic_details.append({
                'frame': i,
                'speed_kmh': current_speed,
                'speed_ms': current_speed / MS_TO_KMH,
                'distance_m': dist_per_frame,
                'correction_factor': 1.0,
            })
            current_speed = max(0.0, current_speed - AIR_RESISTANCE_DECAY)

        return {
            'release_speed_kmh': release_speed,
            'initial_speed_kmh': initial_speed,
            'max_speed_kmh': max_speed,
            'average_speed_kmh': avg_speed_kmh,
            'total_distance_m': distance,
            'effective_distance_m': distance,
            'mound_distance_m': self.theoretical_distance,
            'stride_correction_m': self.stride_correction,
            'flight_time_s': total_time,
            'num_frames': num_frames,
            'frame_details': synthetic_details,
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
        initial_speeds = speed_values[:min(5, len(speed_values))]

        return {
            'release_speed_kmh': release_speed,
            'initial_speed_kmh': float(np.mean(initial_speeds)) if initial_speeds else 0,
            'max_speed_kmh': max(speed_values) if speed_values else 0,
            'average_speed_kmh': float(np.mean(speed_values)) if speed_values else 0,
            'total_distance_m': sum(s['distance_m'] for s in speeds),
            'num_frames': len(trajectory_points),
            'frame_details': speeds,
            'calculation_method': 'pixel_based',
        }
