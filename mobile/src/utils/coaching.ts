import { SpeedInfo, PitchResult, Session } from '../types';
import { KMH_TO_MPH, getSpeedKmh, toDateKey, pitchColor } from './conversions';

export function generateCoachingComment(si?: SpeedInfo): string {
  if (!si) return 'Keep working on consistency and mechanics.';

  const mph = si.release_speed_kmh
    ? si.release_speed_kmh * KMH_TO_MPH
    : si.initial_speed_kmh
      ? si.initial_speed_kmh * KMH_TO_MPH
      : null;
  const rpm = si.spin_rpm ?? null;
  const type = si.pitch_type;
  const parts: string[] = [];

  if (mph !== null) {
    if (mph < 45) parts.push('Focus on building arm strength to increase velocity.');
    else if (mph < 55) parts.push('Work on increasing velocity for more effectiveness.');
    else if (mph < 65) parts.push('Decent velocity. Focus on consistent mechanics.');
    else if (mph < 80) parts.push('Good velocity range. Work on command.');
    else parts.push('Strong pitch velocity.');
  }

  if (rpm !== null) {
    if (rpm < 1000) parts.push('Very low spin — check grip and finger pressure at release.');
    else if (rpm < 1500) parts.push('Spin rate is below average — focus on finger pressure at release.');
    else if (rpm < 2000) parts.push('Moderate spin rate. Try to generate more finger action.');
    else if (rpm < 2500) parts.push('Good spin rate detected.');
    else parts.push('Excellent spin rate — great for movement.');
  }

  if (!parts[1]) {
    if (type === 'Fastball' || type === 'Four-Seam') {
      parts.push('Maintain consistent four-seam grip for maximum ride.');
    } else if (type === 'Curveball') {
      parts.push('Focus on consistent release point for a sharp break.');
    } else if (type === 'Slider') {
      parts.push('Ensure a clean cut at release for sharp horizontal movement.');
    } else if (type === 'Changeup') {
      parts.push('Keep arm speed consistent to disguise the changeup effectively.');
    } else if (type === 'Cutter') {
      parts.push('Small wrist-side pressure at release creates the cut movement.');
    } else if (type === 'Sinker') {
      parts.push('Drive your fingers over the top to generate downward action.');
    }
  }

  return parts.length > 0
    ? parts.slice(0, 2).join(' ')
    : 'Keep working on consistency and mechanics.';
}

export interface TypeStat {
  type: string;
  count: number;
  avgMph: string | null;
  color: string;
}

export function buildTypeStats(records: PitchResult[]): TypeStat[] {
  const map: Record<string, { count: number; speedsKmh: number[] }> = {};
  for (const r of records) {
    const si = r.speed_info || {};
    const type = si.pitch_type && si.pitch_type !== 'Unknown' ? si.pitch_type : 'Unknown';
    const kmh = getSpeedKmh(r);
    if (!map[type]) map[type] = { count: 0, speedsKmh: [] };
    map[type].count += 1;
    if (kmh != null) map[type].speedsKmh.push(kmh);
  }
  return Object.entries(map)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([type, d]) => ({
      type,
      count: d.count,
      avgMph: d.speedsKmh.length
        ? ((d.speedsKmh.reduce((a, b) => a + b, 0) / d.speedsKmh.length) * KMH_TO_MPH).toFixed(1)
        : null,
      color: pitchColor(type),
    }));
}

export function toStrikeZonePitches(records: PitchResult[]) {
  return records
    .filter((r) => {
      const si = r.speed_info || {};
      return si.plate_x_norm != null && si.plate_y_norm != null;
    })
    .map((r) => {
      const si = r.speed_info || {};
      return {
        job_id: r.job_id,
        plate_x_norm: si.plate_x_norm ?? null,
        plate_y_norm: si.plate_y_norm ?? null,
        pitch_type: si.pitch_type || null,
        speed_kmh: getSpeedKmh(r),
      };
    });
}

export function generateSessionSummary(records: PitchResult[]): string {
  const speeds = records
    .map(getSpeedKmh)
    .filter((v): v is number => v !== null)
    .map((kmh) => kmh * KMH_TO_MPH);

  const avgMph = speeds.length
    ? (speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(1)
    : null;
  const maxMph = speeds.length ? Math.max(...speeds).toFixed(1) : null;

  const typeCounts: Record<string, number> = {};
  records.forEach((r) => {
    const t = r.speed_info?.pitch_type;
    if (t && t !== 'Unknown') typeCounts[t] = (typeCounts[t] || 0) + 1;
  });
  const topType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];

  const lines: string[] = [
    `This session: ${records.length} pitch${records.length !== 1 ? 'es' : ''}.`,
    avgMph ? `Average velocity ${avgMph} mph, peak ${maxMph} mph.` : null,
    topType ? `Primary pitch: ${topType[0]} (${topType[1]} pitches).` : null,
  ].filter((v): v is string => v !== null);

  if (avgMph !== null) {
    if (parseFloat(avgMph) < 50) {
      lines.push('Work on arm strength and mechanics to build up velocity.');
    } else if (parseFloat(avgMph) < 65) {
      lines.push('Decent velocity for amateur competition. Focus on location and movement.');
    } else {
      lines.push('Good velocity output. Continue working on command and pitch variety.');
    }
  }

  return lines.join(' ');
}

export function groupIntoSessions(records: PitchResult[]): Session[] {
  const map: Record<string, PitchResult[]> = {};
  for (const r of records) {
    const key = toDateKey(r.created_at);
    if (!map[key]) map[key] = [];
    map[key].push(r);
  }
  return Object.entries(map)
    .sort(([a], [b]) => (a > b ? -1 : 1))
    .map(([dateLabel, recs]) => ({
      dateLabel,
      records: [...recs].sort(
        (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
      ),
    }));
}
