import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { RouteProp, useRoute } from '@react-navigation/native';
import Trajectory3DView from '../components/Trajectory3DView';
import TrajectoryVideoCompare from '../components/trajectory/TrajectoryVideoCompare';
import { PitchResult } from '../types';
import { Colors, FontSize, Layout, Radius, Shadows, Spacing } from '../theme';
import { kmhToMph, pitchColor } from '../utils/conversions';
import { buildTrajectory3DModel } from '../utils/trajectory3d';

type RouteParams = {
  TrajectorySimulation: { pitch: PitchResult; title?: string };
};

function fmt(value: number | null | undefined, digits = 1) {
  return value == null || !Number.isFinite(value) ? '-' : value.toFixed(digits);
}

export default function TrajectorySimulationScreen() {
  const route = useRoute<RouteProp<RouteParams, 'TrajectorySimulation'>>();
  const { pitch } = route.params;
  const [scrollEnabled, setScrollEnabled] = useState(true);
  const model = useMemo(() => buildTrajectory3DModel(pitch), [pitch]);
  const si = pitch.speed_info || {};
  const primaryKmh = si.release_speed_kmh ?? si.initial_speed_kmh ?? null;
  const primaryMph = primaryKmh != null ? kmhToMph(primaryKmh) : null;
  const type = si.pitch_type && si.pitch_type !== 'Unknown' ? si.pitch_type : 'Unknown';
  const color = type !== 'Unknown' ? pitchColor(type) : Colors.accent;
  const syntheticPct = model.syntheticRatio != null ? Math.round(model.syntheticRatio * 100) : null;
  const duration = model.durationS ?? si.flight_time_s ?? null;

  const stats = [
    { label: '球速', value: primaryMph ?? '-', unit: 'mph' },
    { label: '距離', value: fmt(model.distanceM, 1), unit: 'm' },
    { label: '飛行', value: fmt(duration, 3), unit: 's' },
    { label: '樣本', value: String(model.points.length), unit: 'pts' },
    { label: '補點', value: syntheticPct != null ? `${syntheticPct}%` : '-', unit: '' },
    { label: '橫移', value: fmt(si.horizontal_break_cm, 1), unit: 'cm' },
    { label: 'IVB', value: fmt(si.induced_vertical_break_cm, 1), unit: 'cm' },
    { label: '來源', value: model.confidenceLabel, unit: '', wide: true },
  ];

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.content}
      scrollEnabled={scrollEnabled}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.hero}>
        <View style={styles.heroText}>
          <Text style={styles.eyebrow}>TRAJECTORY SIMULATION</Text>
          <Text style={styles.title}>3D 軌跡模擬</Text>
          <Text style={styles.subtitle}>投手丘到本壘板的近似世界座標重建</Text>
        </View>
        {type !== 'Unknown' && (
          <View style={[styles.typePill, { backgroundColor: color }]}>
            <Text style={styles.typeText}>{type}</Text>
          </View>
        )}
      </View>

      <View style={styles.viewerCard}>
        <Trajectory3DView
          model={model}
          pitchColor={color}
          onGestureActiveChange={(active) => setScrollEnabled(!active)}
        />
      </View>

      <View style={styles.card}>
        <TrajectoryVideoCompare pitch={pitch} pitchColor={color} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>模擬資料</Text>
        <Text style={styles.cardSub}>以偵測軌跡、好球帶比例尺與投打距離重建</Text>
        <View style={styles.statGrid}>
          {stats.map((item) => (
            <View key={item.label} style={[styles.statCell, item.wide && styles.statCellWide]}>
              <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
                {item.value}
              </Text>
              <Text style={styles.statLabel}>{item.label}{item.unit ? ` · ${item.unit}` : ''}</Text>
            </View>
          ))}
        </View>
      </View>

      <View style={styles.noteCard}>
        <Text style={styles.noteTitle}>精準度說明</Text>
        <Text style={styles.noteText}>{model.warning}</Text>
        <Text style={styles.noteText}>
          目前深度軸由投打距離建立，左右與高度由畫面座標、好球帶寬高與 break 估算；若要提升成校正級 3D，需要相機內參或額外場地校正。
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  content: {
    alignItems: 'center',
    padding: Spacing.lg,
    paddingBottom: 40,
  },
  hero: {
    width: '100%',
    maxWidth: Layout.maxWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: Spacing.md,
    alignItems: 'flex-start',
    marginBottom: Spacing.md,
  },
  heroText: {
    flex: 1,
  },
  eyebrow: {
    fontSize: FontSize.xs,
    fontWeight: '800',
    color: Colors.textMuted,
    letterSpacing: 0.8,
    marginBottom: 4,
  },
  title: {
    fontSize: 28,
    fontWeight: '900',
    color: Colors.text,
  },
  subtitle: {
    marginTop: 4,
    fontSize: FontSize.md,
    lineHeight: 20,
    color: Colors.textMuted,
  },
  typePill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  typeText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
  },
  viewerCard: {
    width: '100%',
    maxWidth: Layout.maxWidth,
    marginBottom: Spacing.md,
    borderRadius: Radius.xxl,
    ...Shadows.card,
  },
  card: {
    width: '100%',
    maxWidth: Layout.maxWidth,
    backgroundColor: Colors.surface,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
    ...Shadows.soft,
  },
  cardTitle: {
    fontSize: FontSize.lg,
    fontWeight: '800',
    color: Colors.text,
  },
  cardSub: {
    marginTop: 3,
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },
  statGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  statCell: {
    flexBasis: '30%',
    flexGrow: 1,
    minHeight: 64,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.sm,
    justifyContent: 'center',
  },
  statCellWide: {
    flexBasis: '48%',
  },
  statValue: {
    fontSize: 18,
    fontWeight: '900',
    color: Colors.text,
  },
  statLabel: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: '700',
    color: Colors.textMuted,
    textTransform: 'uppercase',
  },
  noteCard: {
    width: '100%',
    maxWidth: Layout.maxWidth,
    backgroundColor: '#e0f2fe',
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: '#bae6fd',
    padding: Spacing.lg,
  },
  noteTitle: {
    fontSize: FontSize.md,
    fontWeight: '900',
    color: '#075985',
    marginBottom: 6,
  },
  noteText: {
    fontSize: FontSize.sm,
    lineHeight: 19,
    color: '#075985',
    marginBottom: 6,
  },
});
