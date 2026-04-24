"""
RuleBasedClassifier  —  deeply-optimised Gaussian / sigmoid scoring.

Why this exists:
  The legacy classifier used step thresholds (`if x > 0.035: score += 3`),
  producing cliffs at class boundaries. Detection noise of 1–2 px near a
  threshold could flip the verdict between Fastball and Curveball.

What changed:
  - All scoring now uses smooth response curves (Gaussian bumps + sigmoid
    rises) so small changes in the raw feature map to small changes in the
  - score.
  - We consume the new temporal features (early/late break, late-break
    ratio), which are physically the single best discriminator between
    fastballs and breaking pitches.
  - A speed prior is applied ONLY when the radar reading is in a sane band,
    so amateur setups without a reliable radar don't get penalised.
  - Confidence combines `softmax-like dominance` with `top-1/top-2 margin`,
    which reflects real separability rather than just the winner's share.
  - Minimum quality gate: if nobody scores ≥ 2.0 the pitch is "Unknown"
    rather than silently defaulting to Fastball.
"""

from __future__ import annotations

import logging
import math
from typing import Dict, Tuple

from .feature_extractor import PitchFeatures, PITCH_UNKNOWN

log = logging.getLogger(__name__)


# ── Soft response helpers ────────────────────────────────────────────────

def _bump(x: float, mean: float, stdev: float) -> float:
    """Gaussian bump; peaks at `mean`, width σ. Returns 0–1."""
    if stdev <= 0:
        stdev = 1e-6
    d = (x - mean) / stdev
    return math.exp(-0.5 * d * d)


def _rise(x: float, center: float, scale: float) -> float:
    """Sigmoid; 0.5 at `center`, transitions over `scale`."""
    if scale <= 0:
        scale = 1e-6
    z = (x - center) / scale
    # Guard against overflow
    if z > 40:
        return 1.0
    if z < -40:
        return 0.0
    return 1.0 / (1.0 + math.exp(-z))


# ── Classifier ───────────────────────────────────────────────────────────

class RuleBasedClassifier:
    def classify(
        self, features: PitchFeatures
    ) -> Tuple[str, float, Dict[str, float]]:
        if features is None:
            return PITCH_UNKNOWN, 0.0, {}

        scores = {
            "Fastball":  self._score_fastball(features),
            "Curveball": self._score_curveball(features),
            "Slider":    self._score_slider(features),
            "Changeup":  self._score_changeup(features),
        }

        # Quality gate — need enough samples to trust feature extraction.
        if features.n_trajectory_points < 4:
            return PITCH_UNKNOWN, 0.0, scores

        sorted_scores = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
        best_type, best_score = sorted_scores[0]
        second_score = sorted_scores[1][1] if len(sorted_scores) > 1 else 0.0

        # Reject if nobody scored high enough — prevents false default.
        if best_score < 2.0:
            return PITCH_UNKNOWN, 0.0, scores

        total_pos = sum(max(0.0, s) for s in scores.values()) + 1e-6
        dominance = max(0.0, best_score) / total_pos                   # 0…1
        margin = (best_score - second_score) / max(1e-6, best_score)   # 0…1

        confidence = max(0.0, min(1.0, 0.6 * dominance + 0.4 * margin))

        return best_type, float(confidence), scores

    # ── Per-class scorers ────────────────────────────────────────────

    def _score_fastball(self, f: PitchFeatures) -> float:
        s = 0.0
        total_break = abs(f.lateral_break) + abs(f.vertical_break)
        curve_total = abs(f.curve_coef_x) + abs(f.curve_coef_y)

        s += 3.0 * _bump(total_break, 0.02, 0.03)
        s += 2.5 * _bump(f.trajectory_linearity, 0.98, 0.05)
        s += 1.5 * _bump(curve_total, 0.05, 0.18)
        s += 1.0 * _bump(f.speed_drop_ratio, 0.0, 0.08)

        if f.has_reliable_speed:
            s += 2.5 * _rise(f.speed_kmh, 128.0, 9.0)

        s += 1.0 * _bump(f.late_break_ratio, 1.0, 0.8)
        s += 0.8 * _bump(f.direction_change_deg, 0.0, 6.0)
        return s

    def _score_curveball(self, f: PitchFeatures) -> float:
        s = 0.0
        abs_lat = abs(f.lateral_break)
        abs_vert = abs(f.vertical_break)

        # Only genuine downward drop counts (y+ is down)
        if f.vertical_break > 0:
            s += 3.0 * _rise(f.vertical_break, 0.030, 0.015)

        vl_ratio = abs_vert / max(abs_lat, 0.005)
        s += 2.0 * _rise(vl_ratio, 1.1, 0.45)

        s += 2.0 * _rise(abs(f.curve_coef_y), 0.22, 0.12)
        s += 2.0 * _rise(f.direction_change_deg, 10.0, 4.5)
        s += 1.5 * _rise(f.late_break_ratio, 1.5, 0.5)

        late_to_early_y = f.late_break_y / max(f.early_break_y, 1e-4)
        s += 1.0 * _rise(late_to_early_y, 1.3, 0.5)

        if f.has_reliable_speed:
            s += 2.0 * _bump(f.speed_kmh, 115.0, 15.0)

        # Flat paths are unlikely to be curveballs.
        if f.trajectory_linearity > 0.985:
            s -= 1.5
        return s

    def _score_slider(self, f: PitchFeatures) -> float:
        s = 0.0
        abs_lat = abs(f.lateral_break)
        abs_vert = abs(f.vertical_break)

        s += 3.0 * _rise(abs_lat, 0.028, 0.015)

        lv_ratio = abs_lat / max(abs_vert, 0.005)
        s += 2.0 * _rise(lv_ratio, 1.0, 0.4)

        s += 1.5 * _bump(abs(f.break_angle_deg), 15.0, 20.0)
        s += 1.5 * _rise(abs(f.curve_coef_x), 0.15, 0.10)
        s += 1.2 * _bump(f.direction_change_deg, 14.0, 6.0)
        s += 1.0 * _rise(f.late_break_ratio, 1.3, 0.4)

        late_to_early_x = f.late_break_x / max(f.early_break_x, 1e-4)
        s += 1.0 * _rise(late_to_early_x, 1.4, 0.5)

        if f.has_reliable_speed:
            s += 1.5 * _bump(f.speed_kmh, 128.0, 12.0)

        # Sliders shouldn't drop like a curve.
        if f.vertical_break > 0.05 and abs_lat < 0.015:
            s -= 1.5
        return s

    def _score_changeup(self, f: PitchFeatures) -> float:
        s = 0.0
        total_break = abs(f.lateral_break) + abs(f.vertical_break)

        s += 2.0 * _bump(total_break, 0.04, 0.035)
        s += 1.5 * _bump(f.trajectory_linearity, 0.94, 0.05)
        s += 2.5 * _bump(f.speed_drop_ratio, 0.14, 0.06)

        if f.has_reliable_speed:
            s += 1.5 * _bump(f.speed_kmh, 120.0, 12.0)

        s += 0.8 * _bump(f.late_break_ratio, 1.1, 0.7)
        s += 0.8 * _bump(f.direction_change_deg, 3.0, 5.0)
        return s
