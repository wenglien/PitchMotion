from __future__ import annotations

import cv2
import copy
import numpy as np
from typing import Optional, TypedDict
from src.FrameInfo import FrameInfo

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
    error: str


def draw_ball_curve(
    frame: np.ndarray, trajectory: list, max_points: int | None = 15
) -> np.ndarray:
    """Draw the ball trajectory curve on a frame with transparency."""
    if not trajectory:
        return frame

    trajectory_weight = 0.5
    temp_frame = frame.copy()

    # Only take the last max_points points for a fixed-length tail
    traj = trajectory[-max_points:] if max_points is not None and len(trajectory) > max_points else trajectory

    ball_points = copy.deepcopy(traj)
    color = ball_points[-1][2]  # Grab color before removing
    for point in ball_points:
        del point[2]
    ball_points_np = np.array(ball_points, dtype="int32")

    cv2.polylines(temp_frame, [ball_points_np], False, color, 10, lineType=cv2.LINE_AA)
    frame = cv2.addWeighted(temp_frame, trajectory_weight, frame, 1 - trajectory_weight, 0)

    last_ball = tuple(traj[-1][:-1])
    cv2.circle(frame, last_ball, 8, (255, 255, 255), -1)

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


def fill_lost_tracking(frame_list: list[FrameInfo]) -> None:
    """Interpolate missing ball positions using quadratic polynomial fitting."""
    balls_x = [frame.ball[0] for frame in frame_list if frame.ball_in_frame]
    balls_y = [frame.ball[1] for frame in frame_list if frame.ball_in_frame]

    # Need at least 3 points for quadratic fit
    if len(balls_x) < 3:
        return

    balls_x, balls_y = _remove_outliers(balls_x, balls_y)

    if len(balls_x) < 3:
        return

    curve = np.polyfit(balls_x, balls_y, 2)
    poly = np.poly1d(curve)

    # Identify sections where the ball lost tracking
    lost_sections: list[list[int]] = []
    in_lost = False

    for idx, frame in enumerate(frame_list):
        if frame.ball_lost_tracking and not in_lost:
            in_lost = True
            lost_sections.append([])
        elif not frame.ball_lost_tracking:
            in_lost = False

        if in_lost:
            lost_sections[-1].append(idx)

    # Fill lost sections with polynomial-interpolated positions
    for lost_section in lost_sections:
        if not lost_section:
            continue

        prev_idx = lost_section[0] - 1
        next_idx = lost_section[-1] + 1
        if prev_idx < 0 or next_idx >= len(frame_list):
            continue

        prev_frame = frame_list[prev_idx]
        last_frame = frame_list[next_idx]
        color = prev_frame.ball_color

        diff = last_frame.ball[0] - prev_frame.ball[0]
        speed = int(diff / (len(lost_section) + 1))

        for i, idx in enumerate(lost_section):
            frame = frame_list[idx]
            x = prev_frame.ball[0] + (speed * (i + 1))
            y = int(poly(x))
            frame.ball_in_frame = True
            frame.ball = (x, y)
            frame.ball_color = color


def distance(x: tuple, y: tuple) -> float:
    """Euclidean distance between two 2D points."""
    return float(np.hypot(x[0] - y[0], x[1] - y[1]))
