import { DEFAULT_SETTINGS, isManualDistanceCalibrated, MAX_MANUAL_MOUND_DISTANCE_M } from '../types';
import type { Settings } from '../types';

export function normalizeSettings(value: unknown): Settings {
  const saved = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<Settings> : {};
  const distance = isManualDistanceCalibrated(saved.moundDistanceM) ? saved.moundDistanceM : 0;
  const stride = saved.strideCorrectionM;
  const validStride = typeof stride === 'number' && Number.isFinite(stride) && stride >= 0
    && stride <= (distance || MAX_MANUAL_MOUND_DISTANCE_M) - 1;
  const confidence = saved.confThreshold;
  const height = saved.pitcherHeightM;
  const zone = saved.strikeZone;
  const validZone = zone && [zone.xMin, zone.xMax, zone.yMin, zone.yMax].every(Number.isFinite)
    && zone.xMin >= 0 && zone.xMin < zone.xMax && zone.xMax <= 1
    && zone.yMin >= 0 && zone.yMin < zone.yMax && zone.yMax <= 1;
  return {
    // Invalid saved compensation requires recalibration, not an unnoticed speed change.
    moundDistanceM: stride != null && !validStride ? 0 : distance,
    strideCorrectionM: validStride ? stride : 0,
    confThreshold: typeof confidence === 'number' && Number.isFinite(confidence) && confidence > 0 && confidence <= 1
      ? confidence : DEFAULT_SETTINGS.confThreshold,
    pitcherHeightM: typeof height === 'number' && Number.isFinite(height) && height >= 1 && height <= 2.4
      ? height : undefined,
    strikeZone: validZone ? { xMin: zone.xMin, xMax: zone.xMax, yMin: zone.yMin, yMax: zone.yMax } : null,
    speedUnit: saved.speedUnit === 'kmh' ? 'kmh' : 'mph',
  };
}
