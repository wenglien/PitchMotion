import type {
  PitchResult,
  TrajectoryMetadata,
  TrajectorySample,
  TrajectoryWorldPoint,
} from '../types';

const DEFAULT_ZONE = { xMin: 0.33, xMax: 0.67, yMin: 0.59, yMax: 0.83 };
const DEFAULT_DISTANCE_M = 18.44;
const DEFAULT_DURATION_S = 0.45;
const DEFAULT_ZONE_WIDTH_M = 0.4318;
const DEFAULT_ZONE_HEIGHT_M = 0.58;
const DEFAULT_RELEASE_HEIGHT_M = 1.8;
const PLATE_ZONE_CENTER_M = 0.9;
export const PITCH_REPLAY_SCALE = 3;
export const BASEBALL_RADIUS_M = 0.037;

export interface StrikeZoneGeometry {
  halfWidthM: number;
  centerYM: number;
  halfHeightM: number;
}

export interface PitchReplayModel {
  points: TrajectoryWorldPoint[];
  strikeZone: StrikeZoneGeometry;
  landingPoint: TrajectoryWorldPoint | null;
  isStrike: boolean | null;
  source: 'native_samples' | 'legacy_points' | 'landing_only';
  distanceM: number;
  durationS: number;
  estimatedRatio: number;
  isEstimated: boolean;
  confidenceLabel: string;
  warning: string;
}

export function buildChallengeCallout(model: PitchReplayModel) {
  const landing = model.landingPoint;
  if (!landing) return null;
  const left = -model.strikeZone.halfWidthM;
  const right = model.strikeZone.halfWidthM;
  const bottom = model.strikeZone.centerYM - model.strikeZone.halfHeightM;
  const top = model.strikeZone.centerYM + model.strikeZone.halfHeightM;
  const centerInside = landing.x >= left && landing.x <= right && landing.y >= bottom && landing.y <= top;
  let x = Math.max(left, Math.min(right, landing.x));
  let y = Math.max(bottom, Math.min(top, landing.y));

  if (centerInside) {
    const edges = [
      { x: left, y: landing.y },
      { x: right, y: landing.y },
      { x: landing.x, y: bottom },
      { x: landing.x, y: top },
    ];
    ({ x, y } = edges.reduce((nearest, edge) => (
      Math.hypot(edge.x - landing.x, edge.y - landing.y)
        < Math.hypot(nearest.x - landing.x, nearest.y - landing.y) ? edge : nearest
    )));
  }

  const centerClearanceM = Math.hypot(x - landing.x, y - landing.y);
  const inside = centerInside || centerClearanceM <= BASEBALL_RADIUS_M;

  return {
    point: { x, y, z: 0 },
    clearanceCm: inside ? 0 : (centerClearanceM - BASEBALL_RADIUS_M) * 100,
    inside,
  };
}

interface SourceSample {
  frame_index?: number;
  time_s?: number;
  x_norm: number;
  y_norm: number;
  is_synthetic: boolean;
  confidence?: number;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function resolveMetadata(pitch: PitchResult): TrajectoryMetadata {
  const si = pitch.speed_info || {};
  return {
    ...pitch.trajectory_metadata,
    mound_distance_m: pitch.trajectory_metadata?.mound_distance_m
      ?? si.mound_distance_m
      ?? si.total_distance_m
      ?? si.effective_distance_m,
    total_distance_m: pitch.trajectory_metadata?.total_distance_m
      ?? si.total_distance_m
      ?? si.effective_distance_m
      ?? si.mound_distance_m,
    release_time_s: pitch.trajectory_metadata?.release_time_s ?? si.release_time_s,
    catch_time_s: pitch.trajectory_metadata?.catch_time_s ?? si.catch_time_s,
    plate_x_norm: pitch.trajectory_metadata?.plate_x_norm ?? si.plate_x_norm,
    plate_y_norm: pitch.trajectory_metadata?.plate_y_norm ?? si.plate_y_norm,
    plate_crossing_x_m: pitch.trajectory_metadata?.plate_crossing_x_m,
    plate_crossing_y_m: pitch.trajectory_metadata?.plate_crossing_y_m,
    is_strike: pitch.trajectory_metadata?.is_strike ?? si.is_strike,
    strike_zone_width_cm: pitch.trajectory_metadata?.strike_zone_width_cm ?? si.strike_zone_width_cm,
    strike_zone_height_cm: pitch.trajectory_metadata?.strike_zone_height_cm ?? si.strike_zone_height_cm,
  };
}

function nativeSamples(samples: TrajectorySample[] | undefined): SourceSample[] {
  return (samples ?? [])
    .filter((sample) => finite(sample.x_norm) && finite(sample.y_norm))
    .map((sample) => ({
      frame_index: sample.frame_index,
      time_s: finite(sample.t_s) ? sample.t_s : undefined,
      x_norm: sample.x_norm,
      y_norm: sample.y_norm,
      is_synthetic: sample.is_synthetic === true,
      confidence: sample.confidence,
    }))
    .sort((a, b) => {
      if (finite(a.time_s) && finite(b.time_s)) return a.time_s - b.time_s;
      return (a.frame_index ?? 0) - (b.frame_index ?? 0);
    });
}

function legacySamples(pitch: PitchResult): SourceSample[] {
  return (pitch.trajectory_points_norm ?? [])
    .filter((point) => finite(point.x) && finite(point.y))
    .map((point, index) => ({
      frame_index: index,
      x_norm: point.x,
      y_norm: point.y,
      is_synthetic: true,
    }));
}

function normalisedRelease(pitch: PitchResult): { x: number; y: number } | null {
  const release = pitch.speed_info?.release_point;
  if (!release || !finite(release.x) || !finite(release.y)) return null;
  if (release.x >= 0 && release.x <= 1 && release.y >= 0 && release.y <= 1) return release;
  if (!finite(pitch.video_width) || !finite(pitch.video_height) || pitch.video_width <= 0 || pitch.video_height <= 0) return null;
  return { x: release.x / pitch.video_width, y: release.y / pitch.video_height };
}

function addEndpointAnchors(
  samples: SourceSample[],
  pitch: PitchResult,
  meta: TrajectoryMetadata,
  plateX: number,
  plateY: number,
) {
  const completed = [...samples];
  const first = completed[0];
  if (first && finite(first.time_s) && finite(meta.release_time_s) && first.time_s > meta.release_time_s) {
    const release = normalisedRelease(pitch) ?? { x: first.x_norm, y: first.y_norm };
    completed.unshift({
      frame_index: pitch.speed_info?.release_frame_idx ?? (first.frame_index != null ? first.frame_index - 1 : undefined),
      time_s: meta.release_time_s,
      x_norm: release.x,
      y_norm: release.y,
      is_synthetic: true,
    });
  }
  const last = completed[completed.length - 1];
  if (last && finite(last.time_s) && finite(meta.catch_time_s) && last.time_s < meta.catch_time_s) {
    completed.push({
      frame_index: pitch.speed_info?.catch_frame_idx ?? (last.frame_index != null ? last.frame_index + 1 : undefined),
      time_s: meta.catch_time_s,
      x_norm: plateX,
      y_norm: plateY,
      is_synthetic: true,
    });
  }
  return completed;
}

function fillFrameGaps(samples: SourceSample[]): SourceSample[] {
  if (samples.length < 2) return samples;
  const filled: SourceSample[] = [samples[0]];
  for (let index = 1; index < samples.length; index++) {
    const previous = samples[index - 1];
    const current = samples[index];
    // ponytail: cap malformed frame gaps; raise only if recordings legitimately exceed 120 missing frames.
    const frameGap = finite(previous.frame_index) && finite(current.frame_index)
      ? Math.min(120, Math.max(1, current.frame_index - previous.frame_index))
      : 1;
    for (let step = 1; step < frameGap; step++) {
      const ratio = step / frameGap;
      filled.push({
        frame_index: previous.frame_index! + step,
        time_s: finite(previous.time_s) && finite(current.time_s)
          ? previous.time_s + (current.time_s - previous.time_s) * ratio
          : undefined,
        x_norm: previous.x_norm + (current.x_norm - previous.x_norm) * ratio,
        y_norm: previous.y_norm + (current.y_norm - previous.y_norm) * ratio,
        is_synthetic: true,
        confidence: Math.min(previous.confidence ?? 1, current.confidence ?? 1),
      });
    }
    filled.push(current);
  }
  return filled;
}

function filterReplayOutliers(samples: SourceSample[]): SourceSample[] {
  if (samples.length < 3) return samples;
  return samples.filter((sample, index) => {
    if (index === 0 || index === samples.length - 1) return true;
    const previous = samples[index - 1];
    const next = samples[index + 1];
    const previousOrder = previous.time_s ?? previous.frame_index;
    const currentOrder = sample.time_s ?? sample.frame_index;
    const nextOrder = next.time_s ?? next.frame_index;
    if (!finite(previousOrder) || !finite(currentOrder) || !finite(nextOrder) || nextOrder <= previousOrder) return true;
    const t = clamp((currentOrder - previousOrder) / (nextOrder - previousOrder), 0, 1);
    const expectedX = previous.x_norm + (next.x_norm - previous.x_norm) * t;
    const expectedY = previous.y_norm + (next.y_norm - previous.y_norm) * t;
    const deviation = Math.hypot(sample.x_norm - expectedX, sample.y_norm - expectedY);
    const neighborTravel = Math.hypot(next.x_norm - previous.x_norm, next.y_norm - previous.y_norm);
    return deviation <= Math.max(0.035, neighborTravel * 0.75);
  });
}

function smoothReplayPoints(points: TrajectoryWorldPoint[]) {
  let smoothed = points;
  for (let pass = 0; pass < 3; pass++) {
    smoothed = smoothed.map((point, index, current) => (
      index === 0 || index === current.length - 1
        ? point
        : {
          ...point,
          x: (current[index - 1].x + 2 * point.x + current[index + 1].x) / 4,
          y: (current[index - 1].y + 2 * point.y + current[index + 1].y) / 4,
        }
    ));
  }
  return smoothed;
}

function landingOnlySamples(pitch: PitchResult, plateX: number, plateY: number, durationS: number): SourceSample[] {
  const release = normalisedRelease(pitch) ?? { x: 0.5, y: 0.36 };
  return Array.from({ length: 24 }, (_, index) => {
    const t = index / 23;
    return {
      frame_index: index,
      time_s: t * durationS,
      x_norm: release.x + (plateX - release.x) * t,
      y_norm: release.y + (plateY - release.y) * t,
      is_synthetic: true,
    };
  });
}

function durationFor(meta: TrajectoryMetadata, samples: SourceSample[], pitch: PitchResult) {
  const release = meta.release_time_s;
  const caught = meta.catch_time_s;
  if (finite(release) && finite(caught) && caught > release) return caught - release;
  const first = samples[0]?.time_s;
  const last = samples[samples.length - 1]?.time_s;
  if (finite(first) && finite(last) && last > first) return last - first;
  return finite(pitch.speed_info?.flight_time_s) && pitch.speed_info.flight_time_s > 0
    ? pitch.speed_info.flight_time_s
    : DEFAULT_DURATION_S;
}

function progressFor(sample: SourceSample, index: number, samples: SourceSample[], meta: TrajectoryMetadata) {
  if (finite(sample.time_s) && finite(meta.release_time_s) && finite(meta.catch_time_s) && meta.catch_time_s > meta.release_time_s) {
    return clamp((sample.time_s - meta.release_time_s) / (meta.catch_time_s - meta.release_time_s), 0, 1);
  }
  const first = samples[0]?.time_s;
  const last = samples[samples.length - 1]?.time_s;
  if (finite(sample.time_s) && finite(first) && finite(last) && last > first) {
    return clamp((sample.time_s - first) / (last - first), 0, 1);
  }
  return samples.length > 1 ? index / (samples.length - 1) : 0;
}

export function buildPitchReplayModel(pitch: PitchResult): PitchReplayModel {
  const meta = resolveMetadata(pitch);
  const plateX = finite(meta.plate_x_norm) ? meta.plate_x_norm : 0.5;
  const plateY = finite(meta.plate_y_norm) ? meta.plate_y_norm : 0.71;

  let source: PitchReplayModel['source'] = 'native_samples';
  let samples = nativeSamples(pitch.trajectory_samples);
  if (samples.length < 2) {
    source = 'legacy_points';
    samples = legacySamples(pitch);
  }
  samples = filterReplayOutliers(samples);

  let durationS = durationFor(meta, samples, pitch);
  if (samples.length < 2) {
    source = 'landing_only';
    samples = landingOnlySamples(pitch, plateX, plateY, durationS);
  } else {
    samples = addEndpointAnchors(samples, pitch, meta, plateX, plateY);
    samples = fillFrameGaps(samples);
    durationS = durationFor(meta, samples, pitch);
  }

  const distanceM = clamp(
    finite(meta.mound_distance_m) ? meta.mound_distance_m
      : finite(meta.total_distance_m) ? meta.total_distance_m
        : DEFAULT_DISTANCE_M,
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
  const zoneWidthM = clamp((finite(meta.strike_zone_width_cm) ? meta.strike_zone_width_cm : DEFAULT_ZONE_WIDTH_M * 100) / 100, 0.3, 0.7);
  const zoneHeightM = clamp((finite(meta.strike_zone_height_cm) ? meta.strike_zone_height_cm : DEFAULT_ZONE_HEIGHT_M * 100) / 100, 0.35, 1.1);
  const zoneCenterX = (zone.xMin + zone.xMax) / 2;
  const zoneCenterY = (zone.yMin + zone.yMax) / 2;
  const zoneNormW = Math.max(0.05, zone.xMax - zone.xMin);
  const zoneNormH = Math.max(0.05, zone.yMax - zone.yMin);
  const lateralFromNorm = (xNorm: number) => ((xNorm - zoneCenterX) / zoneNormW) * zoneWidthM;
  const heightFromNorm = (yNorm: number) => PLATE_ZONE_CENTER_M + ((zoneCenterY - yNorm) / zoneNormH) * zoneHeightM;

  let points = samples.map((sample, index): TrajectoryWorldPoint => {
    const t = progressFor(sample, index, samples, meta);
    return {
      x: lateralFromNorm(sample.x_norm),
      y: DEFAULT_RELEASE_HEIGHT_M * (1 - t) + heightFromNorm(sample.y_norm) * t,
      z: distanceM * (1 - t),
      t,
      time_s: t * durationS,
      frame_index: sample.frame_index,
      is_synthetic: sample.is_synthetic,
      confidence: sample.confidence ?? (sample.is_synthetic ? 0.45 : 1),
    };
  });

  const landing = {
    x: lateralFromNorm(plateX),
    y: heightFromNorm(plateY),
  };
  const last = points[points.length - 1];
  const landingAdjusted = !!last && (Math.abs(last.x - landing.x) > 0.001 || Math.abs(last.y - landing.y) > 0.001 || last.t < 0.999);
  if (last) {
    points[points.length - 1] = {
      ...last,
      ...landing,
      z: 0,
      t: 1,
      time_s: durationS,
      is_synthetic: last.is_synthetic || landingAdjusted,
    };
  }
  points = smoothReplayPoints(points);

  const estimatedCount = points.filter((point) => point.is_synthetic).length;
  const estimatedRatio = points.length ? estimatedCount / points.length : 1;
  const isEstimated = source !== 'native_samples' || landingAdjusted || estimatedCount > 0;
  const isStrike = pitch.speed_info?.is_strike ?? meta.is_strike ?? null;
  const landingPoint = points.length ? { ...points[points.length - 1] } : null;
  const confidenceLabel = !isEstimated ? '實測軌跡' : source === 'native_samples' ? '混合實測／補點' : source === 'legacy_points' ? '舊資料重建' : '落點重建';
  const warning = source === 'native_samples'
    ? '單鏡頭深度為視覺重建；實測時間與畫面軌跡優先。'
    : '缺少完整逐幀資料，畫面已補足供回放參考。';

  return {
    points,
    strikeZone: {
      halfWidthM: zoneWidthM / 2,
      centerYM: PLATE_ZONE_CENTER_M,
      halfHeightM: zoneHeightM / 2,
    },
    landingPoint,
    isStrike: typeof isStrike === 'boolean' ? isStrike : null,
    source,
    distanceM,
    durationS,
    estimatedRatio,
    isEstimated,
    confidenceLabel,
    warning,
  };
}
