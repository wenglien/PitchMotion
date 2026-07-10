import {
  PitchResult,
  TrajectoryMetadata,
  TrajectorySample,
  TrajectoryWorldPoint,
} from '../types';

const DEFAULT_ZONE = { xMin: 0.33, xMax: 0.67, yMin: 0.59, yMax: 0.83 };
const DEFAULT_DISTANCE_M = 18.44;
const DEFAULT_ZONE_WIDTH_M = 0.4318;
const DEFAULT_ZONE_HEIGHT_M = 0.58;
const DEFAULT_RELEASE_HEIGHT_M = 1.8;
// World height (metres above the plate) where the strike-zone centre sits. The
// trajectory's plate-plane landing and the rendered zone box both reference this
// so an in-zone analysis result always lands inside the drawn frame.
const PLATE_ZONE_CENTER_M = 0.9;

export interface StrikeZoneGeometry {
  halfWidthM: number;
  centerYM: number;
  halfHeightM: number;
}

export interface Trajectory3DModel {
  points: TrajectoryWorldPoint[];
  smoothPoints: TrajectoryWorldPoint[];
  strikeZone: StrikeZoneGeometry;
  landingPoint: TrajectoryWorldPoint | null;
  isStrike: boolean | null;
  source: 'native_samples' | 'legacy_points' | 'synthetic';
  distanceM: number;
  durationS: number | null;
  syntheticRatio: number | null;
  confidenceLabel: string;
  warning: string | null;
}

interface SourceSample {
  frame_index?: number;
  time_s?: number;
  x_norm: number;
  y_norm: number;
  is_synthetic?: boolean;
  confidence?: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveMetadata(pitch: PitchResult): TrajectoryMetadata {
  const si = pitch.speed_info || {};
  return {
    ...pitch.trajectory_metadata,
    mound_distance_m: pitch.trajectory_metadata?.mound_distance_m
      ?? si.mound_distance_m
      ?? si.total_distance_m
      ?? si.effective_distance_m
      ?? DEFAULT_DISTANCE_M,
    total_distance_m: pitch.trajectory_metadata?.total_distance_m
      ?? si.total_distance_m
      ?? si.effective_distance_m
      ?? si.mound_distance_m
      ?? DEFAULT_DISTANCE_M,
    release_time_s: pitch.trajectory_metadata?.release_time_s ?? si.release_time_s,
    catch_time_s: pitch.trajectory_metadata?.catch_time_s ?? si.catch_time_s,
    plate_x_norm: pitch.trajectory_metadata?.plate_x_norm ?? si.plate_x_norm,
    plate_y_norm: pitch.trajectory_metadata?.plate_y_norm ?? si.plate_y_norm,
    plate_crossing_x_m: pitch.trajectory_metadata?.plate_crossing_x_m,
    plate_crossing_y_m: pitch.trajectory_metadata?.plate_crossing_y_m,
    release_point_x_m: pitch.trajectory_metadata?.release_point_x_m,
    release_point_y_m: pitch.trajectory_metadata?.release_point_y_m,
    release_point_z_m: pitch.trajectory_metadata?.release_point_z_m,
    is_strike: pitch.trajectory_metadata?.is_strike ?? si.is_strike,
    horizontal_break_cm: pitch.trajectory_metadata?.horizontal_break_cm ?? si.horizontal_break_cm,
    induced_vertical_break_cm: pitch.trajectory_metadata?.induced_vertical_break_cm ?? si.induced_vertical_break_cm,
    strike_zone_width_cm: pitch.trajectory_metadata?.strike_zone_width_cm ?? si.strike_zone_width_cm,
    strike_zone_height_cm: pitch.trajectory_metadata?.strike_zone_height_cm ?? si.strike_zone_height_cm,
  };
}

function samplesFromNative(samples: TrajectorySample[] | undefined): SourceSample[] {
  if (!samples?.length) return [];
  return samples
    .filter((sample) => Number.isFinite(sample.x_norm) && Number.isFinite(sample.y_norm))
    .map((sample) => ({
      frame_index: sample.frame_index,
      time_s: sample.t_s,
      x_norm: sample.x_norm,
      y_norm: sample.y_norm,
      is_synthetic: sample.is_synthetic,
      confidence: sample.confidence,
    }));
}

function samplesFromLegacy(pitch: PitchResult): SourceSample[] {
  const legacy = pitch.trajectory_points_norm || [];
  return legacy
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point, index) => ({
      frame_index: index,
      x_norm: point.x,
      y_norm: point.y,
      is_synthetic: true,
    }));
}

function syntheticSamples(meta: TrajectoryMetadata): SourceSample[] {
  const plateX = finiteOrNull(meta.plate_x_norm) ?? 0.5;
  const plateY = finiteOrNull(meta.plate_y_norm) ?? 0.71;
  const hBreakNorm = clamp((finiteOrNull(meta.horizontal_break_cm) ?? 0) / 120, -0.18, 0.18);
  const ivbNorm = clamp((finiteOrNull(meta.induced_vertical_break_cm) ?? 0) / 140, -0.16, 0.16);
  const samples: SourceSample[] = [];
  for (let i = 0; i < 36; i++) {
    const t = i / 35;
    const late = Math.pow(t, 2.4);
    const gravity = 0.18 * t * t;
    samples.push({
      frame_index: i,
      x_norm: 0.5 + (plateX - 0.5) * t - hBreakNorm * (1 - late),
      y_norm: 0.36 + (plateY - 0.36) * t + gravity - ivbNorm * late,
      is_synthetic: true,
    });
  }
  return samples;
}

function progressForSample(sample: SourceSample, index: number, samples: SourceSample[], meta: TrajectoryMetadata) {
  const releaseTime = finiteOrNull(meta.release_time_s);
  const catchTime = finiteOrNull(meta.catch_time_s);
  if (sample.time_s != null && releaseTime != null && catchTime != null && catchTime > releaseTime) {
    return clamp((sample.time_s - releaseTime) / (catchTime - releaseTime), 0, 1);
  }
  const firstTime = finiteOrNull(samples[0]?.time_s);
  const lastTime = finiteOrNull(samples[samples.length - 1]?.time_s);
  if (sample.time_s != null && firstTime != null && lastTime != null && lastTime > firstTime) {
    return clamp((sample.time_s - firstTime) / (lastTime - firstTime), 0, 1);
  }
  return samples.length > 1 ? index / (samples.length - 1) : 0;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Reject spike outliers: a point that sits far from where its neighbours predict
// it should be (using the time/parameter position between them) is pulled back
// onto the local trend. The tail is guarded separately because catch-point
// extrapolation near the glove is the most common source of wild end jitter.
function rejectOutliers(points: TrajectoryWorldPoint[]): TrajectoryWorldPoint[] {
  if (points.length < 4) return points;
  const steps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    steps.push(Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  const med = median(steps);
  const threshold = Math.max(med * 2.5, 0.12);
  const out = points.map((p) => ({ ...p }));

  for (let i = 1; i < out.length - 1; i++) {
    const prev = out[i - 1];
    const cur = out[i];
    const next = out[i + 1];
    const span = next.t - prev.t;
    const ratio = span > 1e-6 ? clamp((cur.t - prev.t) / span, 0, 1) : 0.5;
    const expX = prev.x + (next.x - prev.x) * ratio;
    const expY = prev.y + (next.y - prev.y) * ratio;
    const dev = Math.hypot(cur.x - expX, cur.y - expY);
    if (dev > threshold) {
      out[i] = { ...cur, x: expX, y: expY };
    }
  }

  // Tail guard: compare the last point against a linear extrapolation of the
  // preceding trend; if it jumps, blend it back toward the prediction.
  const n = out.length;
  const a = out[n - 2];
  const b = out[n - 3];
  const predX = a.x + (a.x - b.x);
  const predY = a.y + (a.y - b.y);
  const devLast = Math.hypot(out[n - 1].x - predX, out[n - 1].y - predY);
  if (devLast > threshold) {
    out[n - 1] = {
      ...out[n - 1],
      x: predX * 0.6 + out[n - 1].x * 0.4,
      y: predY * 0.6 + out[n - 1].y * 0.4,
    };
  }
  return out;
}

// Light denoise: triangular-weighted moving average. Endpoints use a one-sided
// window (instead of being copied verbatim) so an isolated noisy release/catch
// sample can no longer survive as a sharp spike.
function smoothWorldPoints(points: TrajectoryWorldPoint[], radius = 2): TrajectoryWorldPoint[] {
  if (points.length <= 2) return points;
  const result: TrajectoryWorldPoint[] = [];
  for (let i = 0; i < points.length; i++) {
    let wx = 0;
    let wy = 0;
    let wz = 0;
    let weight = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= points.length) continue;
      // Triangular weights keep the centre point dominant so genuine break is
      // preserved while high-frequency detection jitter is averaged out.
      const w = radius + 1 - Math.abs(k);
      wx += points[j].x * w;
      wy += points[j].y * w;
      wz += points[j].z * w;
      weight += w;
    }
    result.push({
      ...points[i],
      x: wx / weight,
      y: wy / weight,
      z: wz / weight,
    });
  }
  return result;
}

// Cap the number of control points so the downstream spline / projection stays
// cheap to re-render during interactive rotation and zoom. Endpoints are kept.
function decimate(points: TrajectoryWorldPoint[], max: number): TrajectoryWorldPoint[] {
  if (points.length <= max) return points;
  const out: TrajectoryWorldPoint[] = [];
  const step = (points.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    out.push(points[Math.round(i * step)]);
  }
  return out;
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (
    2 * p1
    + (-p0 + p2) * t
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  );
}

// Resample the polyline with a Catmull-Rom spline so the rendered curve flows
// smoothly through the (denoised) points instead of showing straight-line kinks.
function resampleSmooth(points: TrajectoryWorldPoint[], samplesPerSegment = 8): TrajectoryWorldPoint[] {
  if (points.length < 3) return points;
  const out: TrajectoryWorldPoint[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const steps = i === points.length - 2 ? samplesPerSegment : samplesPerSegment - 1;
    for (let s = 0; s <= steps; s++) {
      const t = s / samplesPerSegment;
      if (i > 0 && s === 0) continue; // avoid duplicating shared endpoints
      out.push({
        x: catmull(p0.x, p1.x, p2.x, p3.x, t),
        y: catmull(p0.y, p1.y, p2.y, p3.y, t),
        z: catmull(p0.z, p1.z, p2.z, p3.z, t),
        t: p1.t + (p2.t - p1.t) * t,
        time_s: p1.time_s,
        frame_index: p1.frame_index,
        is_synthetic: t < 0.5 ? p1.is_synthetic : p2.is_synthetic,
      });
    }
  }
  return out;
}

// Slide the trajectory tail so its final point lands exactly on the analysed
// plate crossing. The correction is spread over the last few points with a
// decaying weight to avoid introducing a kink at the very end.
function anchorPlateLanding(
  points: TrajectoryWorldPoint[],
  target: { x: number; y: number },
): TrajectoryWorldPoint[] {
  if (points.length < 2) return points;
  const last = points[points.length - 1];
  const dx = target.x - last.x;
  const dy = target.y - last.y;
  const span = Math.min(points.length, 12);
  const out = points.map((p) => ({ ...p }));
  for (let k = 0; k < span; k++) {
    const idx = points.length - 1 - k;
    const w = (span - k) / span; // 1 at the last point, decaying backwards
    out[idx] = { ...out[idx], x: out[idx].x + dx * w, y: out[idx].y + dy * w };
  }
  out[points.length - 1] = { ...out[points.length - 1], x: target.x, y: target.y, z: 0 };
  return out;
}

export function buildTrajectory3DModel(pitch: PitchResult): Trajectory3DModel {
  const meta = resolveMetadata(pitch);
  let source: Trajectory3DModel['source'] = 'native_samples';
  let samples = samplesFromNative(pitch.trajectory_samples);

  if (samples.length < 2) {
    source = 'legacy_points';
    samples = samplesFromLegacy(pitch);
  }
  if (samples.length < 2) {
    source = 'synthetic';
    samples = syntheticSamples(meta);
  }

  const distanceM = clamp(
    finiteOrNull(meta.mound_distance_m) ?? finiteOrNull(meta.total_distance_m) ?? DEFAULT_DISTANCE_M,
    3,
    30,
  );
  const zone = pitch.speed_info?.plate_zone
    ? {
      xMin: pitch.speed_info.plate_zone.x_min,
      xMax: pitch.speed_info.plate_zone.x_max,
      yMin: pitch.speed_info.plate_zone.y_min,
      yMax: pitch.speed_info.plate_zone.y_max,
    }
    : DEFAULT_ZONE;
  const zoneWidthM = clamp((finiteOrNull(meta.strike_zone_width_cm) ?? DEFAULT_ZONE_WIDTH_M * 100) / 100, 0.3, 0.7);
  const zoneHeightM = clamp((finiteOrNull(meta.strike_zone_height_cm) ?? DEFAULT_ZONE_HEIGHT_M * 100) / 100, 0.35, 1.1);
  const zoneCenterX = (zone.xMin + zone.xMax) / 2;
  const zoneCenterY = (zone.yMin + zone.yMax) / 2;
  const zoneNormW = Math.max(0.05, zone.xMax - zone.xMin);
  const zoneNormH = Math.max(0.05, zone.yMax - zone.yMin);

  // Map a normalised image point to the lateral / height world position used by
  // both the trajectory and the strike-zone box. Height is centred on
  // PLATE_ZONE_CENTER_M so the two share one vertical frame of reference.
  const lateralFromNorm = (xNorm: number) => ((xNorm - zoneCenterX) / zoneNormW) * zoneWidthM;
  const plateHeightFromNorm = (yNorm: number) =>
    PLATE_ZONE_CENTER_M + ((zoneCenterY - yNorm) / zoneNormH) * zoneHeightM;

  const points = samples.map((sample, index) => {
    const t = progressForSample(sample, index, samples, meta);
    const x = lateralFromNorm(sample.x_norm);
    const plateHeight = plateHeightFromNorm(sample.y_norm);
    // Blend the pitcher's release height down to the per-sample plate-plane
    // height so the arc starts high and settles onto the analysed location.
    const y = DEFAULT_RELEASE_HEIGHT_M * (1 - t) + plateHeight * t;
    return {
      x,
      y,
      z: distanceM * (1 - t),
      t,
      time_s: sample.time_s,
      frame_index: sample.frame_index,
      is_synthetic: sample.is_synthetic,
      confidence: sample.confidence ?? (sample.is_synthetic ? 0.45 : 1),
    };
  });

  // Anchor the final landing to the analysed plate crossing so the rendered
  // trajectory agrees with is_strike / plate_x_norm / plate_y_norm.
  const plateXNorm = finiteOrNull(meta.plate_x_norm);
  const plateYNorm = finiteOrNull(meta.plate_y_norm);
  const plateLanding = plateXNorm != null && plateYNorm != null
    ? { x: lateralFromNorm(plateXNorm), y: plateHeightFromNorm(plateYNorm) }
    : (() => {
      const mx = finiteOrNull(meta.plate_crossing_x_m);
      const my = finiteOrNull(meta.plate_crossing_y_m);
      return mx != null && my != null ? { x: mx, y: my } : null;
    })();

  const isStrike = pitch.speed_info?.is_strike ?? meta.is_strike ?? null;

  // Keep the rendered curve light: bound control points, then resample with a
  // per-segment count tuned to land near ~90 total points regardless of input.
  const controlPoints = decimate(smoothWorldPoints(rejectOutliers(points)), 32);
  const segmentCount = Math.max(1, controlPoints.length - 1);
  const samplesPerSegment = clamp(Math.round(90 / segmentCount), 3, 10);
  let smoothPoints = resampleSmooth(controlPoints, samplesPerSegment);
  if (plateLanding) {
    smoothPoints = anchorPlateLanding(smoothPoints, plateLanding);
  }

  const strikeZone: StrikeZoneGeometry = {
    halfWidthM: zoneWidthM / 2,
    centerYM: PLATE_ZONE_CENTER_M,
    halfHeightM: zoneHeightM / 2,
  };

  const syntheticCount = points.filter((point) => point.is_synthetic).length;
  const syntheticRatio = points.length ? syntheticCount / points.length : null;
  const durationS = (() => {
    const releaseTime = finiteOrNull(meta.release_time_s);
    const catchTime = finiteOrNull(meta.catch_time_s);
    if (releaseTime != null && catchTime != null && catchTime > releaseTime) return catchTime - releaseTime;
    const first = finiteOrNull(points[0]?.time_s);
    const last = finiteOrNull(points[points.length - 1]?.time_s);
    return first != null && last != null && last > first ? last - first : null;
  })();

  const confidenceLabel = source === 'native_samples'
    ? syntheticRatio != null && syntheticRatio > 0.5 ? '混合實測/補點' : '實測軌跡'
    : source === 'legacy_points'
      ? '舊資料重建'
      : '合成預覽';
  const warning = source === 'native_samples'
    ? '近似世界座標：深度由投打距離推估，左右與高度由畫面比例尺重建。'
    : '此筆資料缺少每幀軌跡，畫面使用降級重建，僅供視覺參考。';

  const landingPoint: TrajectoryWorldPoint | null = plateLanding
    ? {
      x: plateLanding.x,
      y: plateLanding.y,
      z: 0,
      t: 1,
      confidence: 1,
      is_synthetic: false,
    }
    : smoothPoints.length
      ? { ...smoothPoints[smoothPoints.length - 1], z: 0, t: 1 }
      : null;

  return {
    points,
    smoothPoints,
    strikeZone,
    landingPoint,
    isStrike: typeof isStrike === 'boolean' ? isStrike : null,
    source,
    distanceM,
    durationS,
    syntheticRatio,
    confidenceLabel,
    warning,
  };
}
