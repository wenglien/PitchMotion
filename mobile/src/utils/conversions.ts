import { PitchColors, PITCH_PALETTE } from '../theme';

export const KMH_TO_MPH = 0.621371;

export function kmhToMph(kmh: number): string {
  return (kmh * KMH_TO_MPH).toFixed(1);
}

export function pitchColor(type: string): string {
  return PitchColors[type] || '#7c5cfc';
}

export function pitchDotColor(i: number): string {
  return PITCH_PALETTE[i % PITCH_PALETTE.length];
}

export function formatTime(iso?: string): string {
  if (!iso) return '';
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
  if (!iso) return '';
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
  if (m.toLowerCase().includes('theoretical')) return 'Theory';
  if (m.toLowerCase().includes('pixel')) return 'Pixel';
  if (m.toLowerCase().includes('kalman')) return 'Kalman';
  return m.slice(0, 6);
}

export function toDateKey(iso?: string): string {
  if (!iso) return 'Unknown';
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
  return si.release_speed_kmh ?? si.initial_speed_kmh ?? null;
}
