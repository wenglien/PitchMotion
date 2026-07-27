import React, { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { RouteProp, useRoute } from '@react-navigation/native';
import Trajectory3DView from '../components/Trajectory3DView';
import TrajectoryVideoCompare from '../components/trajectory/TrajectoryVideoCompare';
import { PitchResult } from '../types';
import { Colors, FontSize, Layout, Radius, Shadows, Spacing, Surfaces } from '../theme';
import { formatSpeed, pitchColor, pitchTypeLabel, speedUnitLabel } from '../utils/conversions';
import { buildTrajectory3DModel } from '../utils/trajectory3d';
import { useSettings } from '../context/SettingsContext';

type RouteParams = {
  TrajectorySimulation: { pitch: PitchResult; comparePitch?: PitchResult; title?: string };
};

function fmt(value: number | null | undefined, digits = 1) {
  return value == null || !Number.isFinite(value) ? '-' : value.toFixed(digits);
}

export default function TrajectorySimulationScreen() {
  const route = useRoute<RouteProp<RouteParams, 'TrajectorySimulation'>>();
  const { pitch, comparePitch } = route.params;
  const { settings } = useSettings();
  const [scrollEnabled, setScrollEnabled] = useState(true);
  const [showComparison, setShowComparison] = useState(!!comparePitch);
  const model = useMemo(() => buildTrajectory3DModel(pitch), [pitch]);
  const comparisonModel = useMemo(() => comparePitch ? buildTrajectory3DModel(comparePitch) : null, [comparePitch]);
  const si = pitch.speed_info || {};
  const primaryKmh = si.release_speed_kmh ?? si.initial_speed_kmh ?? null;
  const unitLabel = speedUnitLabel(settings.speedUnit);
  const primarySpeed = primaryKmh != null ? formatSpeed(primaryKmh, settings.speedUnit) : null;
  const type = si.pitch_type && si.pitch_type !== 'Unknown' ? si.pitch_type : 'Unknown';
  const color = type !== 'Unknown' ? pitchColor(type) : Colors.accent;
  const syntheticPct = model.syntheticRatio != null ? Math.round(model.syntheticRatio * 100) : null;
  const duration = model.durationS ?? si.flight_time_s ?? null;

  const stats = [
    { label: '球速', value: primarySpeed ?? '-', unit: unitLabel },
    { label: '距離', value: fmt(model.distanceM, 1), unit: 'm' },
    { label: '飛行', value: fmt(duration, 3), unit: 's' },
    { label: '樣本', value: String(model.points.length), unit: '點' },
    { label: '補點', value: syntheticPct != null ? `${syntheticPct}%` : '-', unit: '' },
    { label: '橫移', value: fmt(si.horizontal_break_cm, 1), unit: 'cm' },
    { label: '垂直位移', value: fmt(si.induced_vertical_break_cm, 1), unit: 'cm' },
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
          <Text style={styles.eyebrow}>軌跡模擬</Text>
          <Text style={styles.title}>3D 軌跡模擬</Text>
          <Text style={styles.subtitle}>投手丘到本壘板的近似世界座標重建</Text>
        </View>
        {type !== 'Unknown' && (
          <View style={[styles.typePill, { backgroundColor: color }]}>
            <Text style={styles.typeText}>{pitchTypeLabel(type)}</Text>
          </View>
        )}
      </View>

      <View style={styles.viewerCard}>
        <Trajectory3DView
          model={model}
          pitchColor={color}
          comparisonModel={showComparison ? comparisonModel : null}
          comparisonColor={comparePitch ? pitchColor(comparePitch.speed_info?.pitch_type ?? '') : Colors.accent2}
          comparisonLabel="上一球"
          onGestureActiveChange={(active) => setScrollEnabled(!active)}
        />
      </View>

      {comparePitch && comparisonModel && (
        <View style={styles.compareCard}>
          <View style={styles.compareHeader}>
            <View style={styles.compareHeaderCopy}>
              <Text style={styles.cardTitle}>球路比較</Text>
              <Text style={styles.cardSub}>將上一球疊加在相同視角</Text>
            </View>
            <TouchableOpacity
              style={[styles.compareToggle, showComparison && styles.compareToggleActive]}
              onPress={() => setShowComparison((value) => !value)}
              accessibilityRole="switch"
              accessibilityState={{ checked: showComparison }}
            >
              <Text style={[styles.compareToggleText, showComparison && styles.compareToggleTextActive]}>
                {showComparison ? '已顯示' : '已隱藏'}
              </Text>
            </TouchableOpacity>
          </View>
          <View style={styles.compareGrid}>
            {[
              {
                label: '本球',
                type: pitchTypeLabel(type),
                speed: primarySpeed,
                color,
              },
              {
                label: '上一球',
                type: pitchTypeLabel(comparePitch.speed_info?.pitch_type),
                speed: formatSpeed(comparePitch.speed_info?.release_speed_kmh ?? comparePitch.speed_info?.initial_speed_kmh, settings.speedUnit),
                color: pitchColor(comparePitch.speed_info?.pitch_type ?? ''),
              },
            ].map((item) => (
              <View key={item.label} style={styles.compareColumn}>
                <View style={styles.compareLabelRow}>
                  <View style={[styles.compareDot, { backgroundColor: item.color }]} />
                  <Text style={styles.compareLabel}>{item.label}</Text>
                </View>
                <Text style={styles.compareType}>{item.type}</Text>
                <Text style={styles.compareSpeed}>{item.speed} <Text style={styles.compareUnit}>{unitLabel}</Text></Text>
              </View>
            ))}
          </View>
        </View>
      )}

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
  compareCard: {
    ...Surfaces.card,
    width: '100%',
    maxWidth: Layout.maxWidth,
    marginBottom: Spacing.md,
    ...Shadows.soft,
  },
  compareHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  compareHeaderCopy: { flex: 1 },
  compareToggle: {
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    backgroundColor: Colors.surface2,
  },
  compareToggleActive: { borderColor: Colors.accent, backgroundColor: Colors.accentSubtle },
  compareToggleText: { color: Colors.textMuted, fontSize: FontSize.sm, fontWeight: '800' },
  compareToggleTextActive: { color: Colors.accent },
  compareGrid: { flexDirection: 'row', gap: Spacing.sm },
  compareColumn: {
    flex: 1,
    minHeight: 94,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface2,
    padding: Spacing.md,
  },
  compareLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  compareDot: { width: 8, height: 8, borderRadius: 4 },
  compareLabel: { color: Colors.textMuted, fontSize: FontSize.sm, fontWeight: '800' },
  compareType: { color: Colors.text, fontSize: FontSize.md, fontWeight: '900', marginTop: Spacing.sm },
  compareSpeed: { color: Colors.text, fontSize: FontSize.xl, fontWeight: '900', marginTop: 3 },
  compareUnit: { color: Colors.textMuted, fontSize: FontSize.sm, fontWeight: '700' },
  card: {
    ...Surfaces.card,
    width: '100%',
    maxWidth: Layout.maxWidth,
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
