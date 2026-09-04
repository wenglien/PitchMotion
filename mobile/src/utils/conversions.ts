import { PitchColors, PITCH_PALETTE } from '../theme';

export const KMH_TO_MPH = 0.621371;

export type SpeedUnit = 'mph' | 'kmh';

export function kmhToMph(kmh: number): string {
  return (kmh * KMH_TO_MPH).toFixed(1);
}

export function speedUnitLabel(unit: SpeedUnit): string {
  return unit === 'mph' ? 'mph' : 'km/h';
}

export function speedValue(kmh: number, unit: SpeedUnit): number {
  return unit === 'mph' ? kmh * KMH_TO_MPH : kmh;
}

export function formatSpeed(kmh: number | null | undefined, unit: SpeedUnit, digits = 1): string {
  return kmh == null || !Number.isFinite(kmh) ? '—' : speedValue(kmh, unit).toFixed(digits);
}

const PITCH_TYPE_LABELS: Record<string, string> = {
  Fastball: '快速球',
  'Four-Seam': '四縫線快速球',
  Curveball: '曲球',
  Slider: '滑球',
  Changeup: '變速球',
  Sinker: '伸卡球',
  Cutter: '卡特球',
  Splitter: '指叉球',
  Unknown: '未知球種',
};

export function pitchTypeLabel(type: string | null | undefined): string {
  if (!type) return '未知球種';
  return Object.hasOwn(PITCH_TYPE_LABELS, type) ? PITCH_TYPE_LABELS[type] : type;
}

export function pitchColor(type: string): string {
  return Object.hasOwn(PitchColors, type) ? PitchColors[type] : '#7c5cfc';
}

export function pitchDotColor(i: number): string {
  return PITCH_PALETTE[i % PITCH_PALETTE.length];
}

export function formatTime(iso?: string): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '';
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

export function formatDate(iso?: string): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return '';
  }
}

export function shortMethod(m?: string): string {
  if (!m) return '—';
  if (m.toLowerCase().includes('theoretical')) return '物理推估';
  if (m.toLowerCase().includes('pixel')) return '影像量測';
  if (m.toLowerCase().includes('kalman')) return '軌跡濾波';
  return m.slice(0, 6);
}

export function toDateKey(iso?: string): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return 'Unknown';
  try {
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}/${m}/${day}`;
  } catch {
    return 'Unknown';
  }
}

export function getSpeedKmh(r: { speed_info?: { release_speed_kmh?: number; initial_speed_kmh?: number } }): number | null {
  const si = r.speed_info || {};
  return [si.release_speed_kmh, si.initial_speed_kmh]
    .find((value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0) ?? null;
}
