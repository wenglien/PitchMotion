import { SpeedInfo, PitchResult, Session } from '../types';
import {
  KMH_TO_MPH,
  SpeedUnit,
  formatSpeed,
  getSpeedKmh,
  pitchColor,
  pitchTypeLabel,
  speedUnitLabel,
  toDateKey,
} from './conversions';

export function generateCoachingComment(si?: SpeedInfo): string {
  if (!si) return '持續練習出手一致性與投球動作。';

  const mph = si.release_speed_kmh
    ? si.release_speed_kmh * KMH_TO_MPH
    : si.initial_speed_kmh
      ? si.initial_speed_kmh * KMH_TO_MPH
      : null;
  const rpm = si.spin_rpm ?? null;
  const type = si.pitch_type;
  const parts: string[] = [];

  if (mph !== null) {
    if (mph < 45) parts.push('先穩定下肢發力與手臂路徑，再逐步提升球速。');
    else if (mph < 55) parts.push('球速仍有成長空間，優先維持完整加速與隨揮。');
    else if (mph < 65) parts.push('球速表現穩定，下一步可專注出手點一致性。');
    else if (mph < 80) parts.push('球速表現良好，可以把練習重點轉向控球。');
    else parts.push('本球球速具有壓制力，請持續維持動作效率。');
  }

  if (rpm !== null) {
    if (rpm < 1000) parts.push('轉速偏低，可檢查握球與出手瞬間的指尖壓力。');
    else if (rpm < 1500) parts.push('轉速略低，練習讓手指完整通過球的後方。');
    else if (rpm < 2000) parts.push('轉速中等，可加強出手時的指尖動作。');
    else if (rpm < 2500) parts.push('轉速表現良好，持續維持相同握球與出手。');
    else parts.push('轉速表現突出，有助於製造更明顯的球路位移。');
  }

  if (!parts[1]) {
    if (type === 'Fastball' || type === 'Four-Seam') {
      parts.push('維持四縫線握法與一致出手，讓球路保持上竄感。');
    } else if (type === 'Curveball') {
      parts.push('固定出手點，讓曲球的下墜更集中。');
    } else if (type === 'Slider') {
      parts.push('出手時保持乾淨的側向切球，強化水平位移。');
    } else if (type === 'Changeup') {
      parts.push('保持和快速球相同的手臂速度，提升變速效果。');
    } else if (type === 'Cutter') {
      parts.push('出手時維持輕微手套側壓力，建立卡特球位移。');
    } else if (type === 'Sinker') {
      parts.push('讓手指從球上方完整通過，製造向下位移。');
    }
  }

  return parts.length > 0
    ? parts.slice(0, 2).join(' ')
    : '持續練習出手一致性與投球動作。';
}

export interface TypeStat {
  type: string;
  count: number;
  avgKmh: number | null;
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
      avgKmh: d.speedsKmh.length
        ? d.speedsKmh.reduce((a, b) => a + b, 0) / d.speedsKmh.length
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

export function generateSessionSummary(records: PitchResult[], speedUnit: SpeedUnit = 'mph'): string {
  const speeds = records
    .map(getSpeedKmh)
    .filter((v): v is number => v !== null);

  const avgKmh = speeds.length
    ? speeds.reduce((a, b) => a + b, 0) / speeds.length
    : null;
  const maxKmh = speeds.length ? Math.max(...speeds) : null;

  const typeCounts: Record<string, number> = {};
  records.forEach((r) => {
    const t = r.speed_info?.pitch_type;
    if (t && t !== 'Unknown') typeCounts[t] = (typeCounts[t] || 0) + 1;
  });
  const topType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];

  const lines: string[] = [
    `本次練習共 ${records.length} 球。`,
    avgKmh != null && maxKmh != null
      ? `平均球速 ${formatSpeed(avgKmh, speedUnit)} ${speedUnitLabel(speedUnit)}，最高 ${formatSpeed(maxKmh, speedUnit)} ${speedUnitLabel(speedUnit)}。`
      : null,
    topType ? `主要球種為${pitchTypeLabel(topType[0])}，共 ${topType[1]} 球。` : null,
  ].filter((v): v is string => v !== null);

  if (avgKmh !== null) {
    const avgMph = avgKmh * KMH_TO_MPH;
    if (avgMph < 50) {
      lines.push('下一次練習可先維持動作完整，再逐步提升球速。');
    } else if (avgMph < 65) {
      lines.push('球速已有基礎，建議把重點放在落點與球路位移的一致性。');
    } else {
      lines.push('球速輸出良好，可繼續加強控球與球種搭配。');
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
