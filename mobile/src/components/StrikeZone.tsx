import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Rect, Text as SvgText } from 'react-native-svg';
import { Colors } from '../theme';
import { SessionPitch } from '../types';
import { formatSpeed, pitchDotColor, pitchTypeLabel, speedUnitLabel } from '../utils/conversions';
import { useSettings } from '../context/SettingsContext';

const DEFAULT_ZONE = { xMin: 0.33, xMax: 0.67, yMin: 0.59, yMax: 0.83 };
const W = 270;
const H = 270;
const ZONE_X = 65;
const ZONE_Y = 42;
const ZONE_W = 140;
const ZONE_H = 174;

interface Props {
  pitches?: SessionPitch[];
  zoneOverride?: { xMin: number; xMax: number; yMin: number; yMax: number } | null;
}

export default function StrikeZone({ pitches = [], zoneOverride = null }: Props) {
  const { settings } = useSettings();
  const zone = zoneOverride ?? DEFAULT_ZONE;
  const unit = speedUnitLabel(settings.speedUnit);
  const zoneWidth = Math.max(0.05, zone.xMax - zone.xMin);
  const zoneHeight = Math.max(0.05, zone.yMax - zone.yMin);
  const dots = pitches
    .filter((pitch) => pitch.plate_x_norm != null && pitch.plate_y_norm != null)
    .map((pitch, index) => ({
      pitch,
      index,
      x: Math.max(12, Math.min(W - 12, ZONE_X + ((pitch.plate_x_norm! - zone.xMin) / zoneWidth) * ZONE_W)),
      y: Math.max(12, Math.min(H - 12, ZONE_Y + ((pitch.plate_y_norm! - zone.yMin) / zoneHeight) * ZONE_H)),
    }));

  return (
    <View style={styles.wrap}>
      <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
        <Rect x={0} y={0} width={W} height={H} rx={18} fill="#f8fbff" />
        <Rect x={ZONE_X} y={ZONE_Y} width={ZONE_W} height={ZONE_H} rx={4} fill="#e0f2fe" stroke="#0284c7" strokeWidth={2} />
        {[1 / 3, 2 / 3].map((ratio) => (
          <React.Fragment key={ratio}>
            <Line x1={ZONE_X + ZONE_W * ratio} y1={ZONE_Y} x2={ZONE_X + ZONE_W * ratio} y2={ZONE_Y + ZONE_H} stroke="#7dd3fc" strokeWidth={1} />
            <Line x1={ZONE_X} y1={ZONE_Y + ZONE_H * ratio} x2={ZONE_X + ZONE_W} y2={ZONE_Y + ZONE_H * ratio} stroke="#7dd3fc" strokeWidth={1} />
          </React.Fragment>
        ))}
        {dots.map(({ pitch, index, x, y }) => {
          const inZone = x >= ZONE_X && x <= ZONE_X + ZONE_W && y >= ZONE_Y && y <= ZONE_Y + ZONE_H;
          const color = pitchDotColor(index);
          return (
            <React.Fragment key={pitch.job_id || index}>
              <Circle cx={x} cy={y} r={11} fill={color} opacity={0.2} />
              <Circle cx={x} cy={y} r={8} fill={color} stroke={inZone ? '#fff' : '#ef4444'} strokeWidth={2} />
              <SvgText x={x} y={y + 3} textAnchor="middle" fontSize={8} fill="#fff" fontWeight="800">{index + 1}</SvgText>
            </React.Fragment>
          );
        })}
        {!dots.length ? <SvgText x={W / 2} y={H / 2} textAnchor="middle" fill="#94a3b8" fontSize={12}>尚無投球落點</SvgText> : null}
      </Svg>

      {dots.length ? (
        <View style={styles.legend}>
          {dots.map(({ pitch, index }) => (
            <View key={pitch.job_id || index} style={styles.legendItem}>
              <View style={[styles.dot, { backgroundColor: pitchDotColor(index) }]} />
              <Text style={styles.legendText}>
                #{index + 1}{pitch.pitch_type ? ` ${pitchTypeLabel(pitch.pitch_type)}` : ''}
                {pitch.speed_kmh != null ? ` · ${formatSpeed(pitch.speed_kmh, settings.speedUnit, 0)}${unit}` : ''}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, maxWidth: 270 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  legendText: { color: Colors.textMuted, fontSize: 11 },
});
