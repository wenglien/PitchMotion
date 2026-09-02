import type { PitchResult } from '../types';

export interface BullpenMetrics {
  measuredCount: number;
  measurementRate: number | null;
  locatedCount: number;
  strikeRate: number | null;
  avgSpeedKmh: number | null;
  maxSpeedKmh: number | null;
  speedStdDevKmh: number | null;
  velocityDeltaKmh: number | null;
  avgHorizontalBreakCm: number | null;
  avgIvbCm: number | null;
}

const average = (values: number[]) => (
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
);

const speedKmh = (record: PitchResult) => (
  record.speed_info?.release_speed_kmh ?? record.speed_info?.initial_speed_kmh ?? null
);

export function buildBullpenMetrics(records: PitchResult[]): BullpenMetrics {
  const speeds = records.map(speedKmh).filter((value): value is number => value !== null);
  const avgSpeedKmh = average(speeds);
  const chronologicalSpeeds = [...records]
    .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime())
    .map(speedKmh)
    .filter((value): value is number => value !== null);
  const split = Math.ceil(chronologicalSpeeds.length / 2);
  const firstHalf = average(chronologicalSpeeds.slice(0, split));
  const secondHalf = average(chronologicalSpeeds.slice(split));
  const located = records.filter((record) => typeof record.speed_info?.is_strike === 'boolean');
  const horizontalBreak = records
    .map((record) => record.speed_info?.horizontal_break_cm)
    .filter((value): value is number => value != null && Number.isFinite(value));
  const ivb = records
    .map((record) => record.speed_info?.induced_vertical_break_cm)
    .filter((value): value is number => value != null && Number.isFinite(value));

  return {
    measuredCount: speeds.length,
    measurementRate: records.length ? speeds.length / records.length : null,
    locatedCount: located.length,
    strikeRate: located.length
      ? located.filter((record) => record.speed_info?.is_strike === true).length / located.length
      : null,
    avgSpeedKmh,
    maxSpeedKmh: speeds.length ? Math.max(...speeds) : null,
    speedStdDevKmh: avgSpeedKmh == null
      ? null
      : Math.sqrt(speeds.reduce((sum, value) => sum + (value - avgSpeedKmh) ** 2, 0) / speeds.length),
    velocityDeltaKmh: firstHalf != null && secondHalf != null ? secondHalf - firstHalf : null,
    avgHorizontalBreakCm: average(horizontalBreak),
    avgIvbCm: average(ivb),
  };
}
