import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { RouteProp, useRoute } from '@react-navigation/native';
import PitchReplay from '../components/PitchReplay';
import TrajectoryVideoCompare from '../components/trajectory/TrajectoryVideoCompare';
import { PitchResult } from '../types';
import { Colors, FontSize, Layout, Radius, Shadows, Spacing, Surfaces } from '../theme';
import { formatSpeed, pitchColor, pitchTypeLabel, speedUnitLabel } from '../utils/conversions';
import { buildPitchReplayModel } from '../utils/pitchReplay';
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
  const handleGestureActiveChange = useCallback((active: boolean) => setScrollEnabled(!active), []);
  const model = useMemo(() => buildPitchReplayModel(pitch), [pitch]);
  const si = pitch.speed_info || {};
  const primaryKmh = si.release_speed_kmh ?? si.initial_speed_kmh ?? null;
  const unitLabel = speedUnitLabel(settings.speedUnit);
  const primarySpeed = primaryKmh != null ? formatSpeed(primaryKmh, settings.speedUnit) : null;
  const type = si.pitch_type && si.pitch_type !== 'Unknown' ? si.pitch_type : 'Unknown';
  const color = type !== 'Unknown' ? pitchColor(type) : Colors.accent;
  const syntheticPct = Math.round(model.estimatedRatio * 100);
  const duration = model.durationS;

  const stats = [
    { label: '球速', value: primarySpeed ?? '-', unit: unitLabel },
    { label: '距離', value: fmt(model.distanceM, 1), unit: 'm' },
    { label: '飛行', value: fmt(duration, 3), unit: 's' },
    { label: '樣本', value: String(model.points.length), unit: '點' },
    { label: '補點', value: syntheticPct != null ? `${syntheticPct}%` : '-', unit: '' },
    { label: '橫移', value: fmt(si.horizontal_break_cm, 1), unit: 'cm' },
    { label: '垂直位移', value: fmt(si.induced_vertical_break_cm, 1), unit: 'cm' },
    { label: '3D 校正', value: model.endpointCalibrated ? '端點校正' : '畫面估算', unit: '' },
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
          <Text style={styles.eyebrow}>進壘回放</Text>
          <Text style={styles.title}>互動 3D 進壘回放</Text>
          <Text style={styles.subtitle}>暫停動畫後可自由旋轉與縮放查看球路</Text>
        </View>
        {type !== 'Unknown' && (
          <View style={[styles.typePill, { backgroundColor: color }]}>
            <Text style={styles.typeText}>{pitchTypeLabel(type)}</Text>
          </View>
        )}
      </View>

      <View style={styles.viewerCard}>
        <PitchReplay
          pitch={pitch}
          previousPitch={comparePitch}
          interactive
          onGestureActiveChange={handleGestureActiveChange}
        />
      </View>

      <View style={styles.card}>
        <TrajectoryVideoCompare pitch={pitch} pitchColor={color} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>軌跡資料</Text>
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
          {model.endpointCalibrated
            ? '3D 起點與終點採原生分析的世界座標校正，中段曲線保留畫面實測形變；單鏡頭無法觀測的深度仍依飛行時間重建。'
            : '本次資料缺少世界座標端點，3D 會以好球帶比例尺和投打距離重建；完成場地或相機校正後可提高絕對位置精度。'}
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
