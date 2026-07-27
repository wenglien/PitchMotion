import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Colors, Radius, Shadows, Spacing } from '../theme';
import { PitchResult } from '../types';
import { formatSpeed, pitchColor, pitchTypeLabel, formatTime, formatDate, shortMethod, speedUnitLabel } from '../utils/conversions';
import { generateCoachingComment } from '../utils/coaching';
import { useSettings } from '../context/SettingsContext';

interface Props {
  pitch: PitchResult;
  index: number;
  onViewTrajectory?: () => void;
}

export default function PitchCard({ pitch, index, onViewTrajectory }: Props) {
  const { settings } = useSettings();
  const unitLabel = speedUnitLabel(settings.speedUnit);
  const si = pitch?.speed_info || {};

  const speed = si.release_speed_kmh
    ? formatSpeed(si.release_speed_kmh, settings.speedUnit)
    : si.initial_speed_kmh
      ? formatSpeed(si.initial_speed_kmh, settings.speedUnit)
      : null;
  const maxSpeed = si.max_speed_kmh ? formatSpeed(si.max_speed_kmh, settings.speedUnit) : null;
  const distM = si.total_distance_m ?? si.effective_distance_m ?? null;
  const flightS = si.flight_time_s ?? null;
  const spinRpm = si.spin_rpm ?? null;
  const breakH = si.horizontal_break_cm ?? null;
  const breakV = si.induced_vertical_break_cm ?? null;
  const breakTotal = si.total_break_cm ?? null;
  const confPct = si.pitch_confidence != null
    ? Math.round(si.pitch_confidence * 100)
    : null;
  const method = shortMethod(si.calculation_method);
  const hasWarn = !!si.trajectory_quality_warning;
  const pitchType = si.pitch_type && si.pitch_type !== 'Unknown' ? si.pitch_type : null;
  const comment = generateCoachingComment(si);

  const cells = [
    { label: '球速', value: speed ?? '-', unit: unitLabel },
    { label: '最高', value: maxSpeed ?? '-', unit: unitLabel },
    { label: '距離', value: distM != null ? distM.toFixed(1) : '-', unit: 'm' },
    { label: '飛行', value: flightS != null ? flightS.toFixed(3) : '-', unit: 's' },
    { label: '橫移', value: breakH != null ? breakH.toFixed(1) : '-', unit: 'cm' },
    { label: '垂直位移', value: breakV != null ? breakV.toFixed(1) : '-', unit: 'cm' },
    { label: '總位移', value: breakTotal != null ? breakTotal.toFixed(1) : '-', unit: 'cm' },
    { label: '轉速', value: spinRpm != null ? Math.round(spinRpm).toLocaleString() : '-', unit: 'rpm' },
    { label: '信心', value: confPct != null ? `${confPct}%` : '-', unit: '' },
    { label: '方法', value: method, unit: '', small: true },
    { label: '品質', value: hasWarn ? '警告' : 'OK', unit: '', color: hasWarn ? Colors.yellow : Colors.green },
  ];

  const a11yLabel = [
    `第 ${index} 球`,
    pitchType ?? '',
    speed !== null ? `球速 ${speed} ${unitLabel}` : '',
    spinRpm !== null ? `轉速 ${Math.round(spinRpm)} rpm` : '',
    hasWarn ? '軌跡品質警告' : '',
  ].filter(Boolean).join('，');

  return (
    <View style={styles.card} accessible accessibilityLabel={a11yLabel}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.timestamp}>
            {formatDate(pitch?.created_at)} {formatTime(pitch?.created_at)}
          </Text>
          <Text style={styles.pitchNum}>第 {index} 球</Text>
        </View>
        {pitchType && (
          <View style={[styles.typeBadge, { backgroundColor: pitchColor(pitchType) }]}>
            <Text style={styles.typeBadgeText}>{pitchTypeLabel(pitchType)}</Text>
          </View>
        )}
      </View>

      {/* Stat grid */}
      <View style={styles.statGrid}>
        {cells.map((c) => (
          <View key={c.label} style={styles.statCell}>
            <Text style={styles.cellLabel}>{c.label}</Text>
            <Text
              style={[
                styles.cellValue,
                c.small && { fontSize: 11 },
                c.color ? { color: c.color } : undefined,
              ]}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.72}
            >
              {c.value}
            </Text>
            {c.unit ? <Text style={styles.cellUnit}>{c.unit}</Text> : null}
          </View>
        ))}
      </View>

      {/* Coaching comment */}
      <View style={styles.comment}>
        <Text style={styles.commentLabel}>本球建議</Text>
        <Text style={styles.commentBody}>{comment}</Text>
      </View>
      {onViewTrajectory && (
        <TouchableOpacity
          style={styles.trajectoryBtn}
          onPress={onViewTrajectory}
          accessibilityRole="button"
          accessibilityLabel={`查看第 ${index} 球的 3D 軌跡模擬`}
          activeOpacity={0.75}
        >
          <Text style={styles.trajectoryBtnText}>查看 3D 軌跡</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.md,
    ...Shadows.soft,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
    gap: 8,
  },
  timestamp: {
    fontSize: 11,
    color: Colors.textMuted,
    marginBottom: 4,
  },
  pitchNum: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.text,
  },
  typeBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 999,
  },
  typeBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fff',
  },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    columnGap: 6,
    rowGap: 6,
    marginBottom: 10,
  },
  statCell: {
    // 4-col grid: each cell takes ~23% and grows to fill the leftover, so
    // cells line up regardless of container width and gap math doesn't break.
    flexBasis: '23%',
    flexGrow: 1,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    padding: 8,
    paddingHorizontal: 6,
    alignItems: 'center',
    minWidth: 60,
    minHeight: 62,
  },
  cellLabel: {
    fontSize: 10,
    textTransform: 'uppercase',
    letterSpacing: 0,
    color: Colors.textMuted,
    marginBottom: 4,
  },
  cellValue: {
    fontSize: 16,
    fontWeight: '800',
    color: Colors.text,
    lineHeight: 16,
  },
  cellUnit: {
    fontSize: 9,
    color: Colors.textMuted,
    marginTop: 2,
  },
  comment: {
    backgroundColor: 'rgba(37, 99, 235, 0.05)',
    borderWidth: 1,
    borderColor: 'rgba(14, 165, 233, 0.2)',
    borderRadius: Radius.md,
    padding: 8,
    paddingHorizontal: 10,
    paddingBottom: 10,
  },
  commentLabel: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    color: Colors.textMuted,
  },
  commentBody: {
    fontSize: 13,
    color: Colors.text,
    lineHeight: 19.5,
  },
  trajectoryBtn: {
    marginTop: 12,
    minHeight: 42,
    borderRadius: Radius.lg,
    backgroundColor: Colors.panel,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trajectoryBtnText: {
    color: Colors.textInverse,
    fontSize: 13,
    fontWeight: '800',
  },
});
