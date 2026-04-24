import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors } from '../theme';
import { PitchResult } from '../types';
import { kmhToMph, pitchColor, formatTime, formatDate, shortMethod } from '../utils/conversions';
import { generateCoachingComment } from '../utils/coaching';

interface Props {
  pitch: PitchResult;
  index: number;
}

export default function PitchCard({ pitch, index }: Props) {
  const si = pitch?.speed_info || {};

  const vMph = si.release_speed_kmh
    ? kmhToMph(si.release_speed_kmh)
    : si.initial_speed_kmh
      ? kmhToMph(si.initial_speed_kmh)
      : null;
  const maxMph = si.max_speed_kmh ? kmhToMph(si.max_speed_kmh) : null;
  const distM = si.total_distance_m ?? si.effective_distance_m ?? null;
  const flightS = si.flight_time_s ?? null;
  const spinRpm = si.spin_rpm ?? null;
  const confPct = si.pitch_confidence != null
    ? Math.round(si.pitch_confidence * 100)
    : null;
  const method = shortMethod(si.calculation_method);
  const hasWarn = !!si.trajectory_quality_warning;
  const pitchType = si.pitch_type && si.pitch_type !== 'Unknown' ? si.pitch_type : null;
  const comment = generateCoachingComment(si);

  const cells = [
    { label: 'V', value: vMph ?? '—', unit: 'mph' },
    { label: 'Max', value: maxMph ?? '—', unit: 'mph' },
    { label: 'Dist', value: distM != null ? distM.toFixed(1) : '—', unit: 'm' },
    { label: 'Flight', value: flightS != null ? flightS.toFixed(3) : '—', unit: 's' },
    { label: 'Spin', value: spinRpm != null ? Math.round(spinRpm).toLocaleString() : '—', unit: 'rpm' },
    { label: 'Conf', value: confPct != null ? `${confPct}%` : '—', unit: '' },
    { label: 'Method', value: method, unit: '', small: true },
    { label: 'Quality', value: hasWarn ? '⚠️' : '✓', unit: '', color: hasWarn ? Colors.yellow : Colors.green },
  ];

  return (
    <View style={styles.card}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.timestamp}>
            {formatDate(pitch?.created_at)} {formatTime(pitch?.created_at)}
          </Text>
          <Text style={styles.pitchNum}>{index}. Pitch</Text>
        </View>
        {pitchType && (
          <View style={[styles.typeBadge, { backgroundColor: pitchColor(pitchType) }]}>
            <Text style={styles.typeBadgeText}>{pitchType}</Text>
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
                c.small && { fontSize: 12 },
                c.color ? { color: c.color } : undefined,
              ]}
            >
              {c.value}
            </Text>
            {c.unit ? <Text style={styles.cellUnit}>{c.unit}</Text> : null}
          </View>
        ))}
      </View>

      {/* Coaching comment */}
      <View style={styles.comment}>
        <Text style={styles.commentLabel}>COMMENT</Text>
        <Text style={styles.commentBody}>{comment}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 16,
    padding: 14,
    paddingBottom: 12,
    marginHorizontal: 12,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
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
    borderRadius: 99,
  },
  typeBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fff',
  },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 10,
  },
  statCell: {
    width: '23%' as any,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    padding: 8,
    paddingHorizontal: 6,
    alignItems: 'center',
  },
  cellLabel: {
    fontSize: 9,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: Colors.textMuted,
    marginBottom: 4,
  },
  cellValue: {
    fontSize: 16,
    fontWeight: '700',
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
    borderColor: 'rgba(37, 99, 235, 0.18)',
    borderRadius: 10,
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
});
