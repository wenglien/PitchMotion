import React, { useState } from 'react';
import { View, Text, ScrollView, FlatList, StyleSheet, TouchableOpacity } from 'react-native';
import { RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import { Colors, Spacing, Radius, FontSize, Shadows } from '../theme';
import { Session, PitchResult } from '../types';
import { formatSpeed, getSpeedKmh, pitchColor, pitchDotColor, pitchTypeLabel, speedUnitLabel, speedValue } from '../utils/conversions';
import {
  buildTypeStats,
  toStrikeZonePitches,
  generateSessionSummary,
  generateCoachingComment,
} from '../utils/coaching';
import { buildBullpenMetrics } from '../utils/sessionAnalysis';
import PitchCard from '../components/PitchCard';
import StrikeZone from '../components/StrikeZone';
import SegmentedTabs from '../components/SegmentedTabs';
import { useSettings } from '../context/SettingsContext';
import TrendChart from '../components/TrendChart';

type RouteParams = { SessionDetail: { session: Session } };

const TABS = ['投球列表', '落點', '牛棚分析', 'Tunnel'];

function ListTab({ records }: { records: PitchResult[] }) {
  const navigation = useNavigation<any>();

  if (records.length === 0) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyText}>此次練習無投球紀錄。</Text>
      </View>
    );
  }
  return (
    <FlatList
      data={records}
      keyExtractor={(r, i) => r.job_id || String(i)}
      renderItem={({ item, index }) => (
        <PitchCard
          pitch={item}
          index={records.length - index}
          onViewTrajectory={() => navigation.navigate('TrajectorySimulation', {
            pitch: item,
            comparePitch: records[index + 1] ?? records[index - 1],
            title: `第 ${records.length - index} 球互動 3D 回放`,
          })}
        />
      )}
      contentContainerStyle={{ paddingTop: Spacing.sm, paddingBottom: Spacing.xl }}
    />
  );
}

function GraphTab({ records }: { records: PitchResult[] }) {
  const { settings } = useSettings();
  const pitches = toStrikeZonePitches(records);
  const typeStats = buildTypeStats(records);
  const plateZone = records.find((r) => r.speed_info?.plate_zone)?.speed_info?.plate_zone;
  const zoneOverride = plateZone
    ? { xMin: plateZone.x_min, xMax: plateZone.x_max, yMin: plateZone.y_min, yMax: plateZone.y_max }
    : null;

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>好球帶落點</Text>
        <Text style={styles.sectionSub}>{pitches.length} 球已標記</Text>
        <View style={{ alignItems: 'center', marginTop: Spacing.md }}>
          <StrikeZone pitches={pitches} zoneOverride={zoneOverride} />
        </View>
      </View>

      {typeStats.length > 0 && (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>球種分佈</Text>
          <View style={styles.divider} />
          <View style={styles.tableRow}>
            <Text style={[styles.tableHeader, { flex: 2, textAlign: 'left' }]}>球種</Text>
            <Text style={styles.tableHeader}>數量</Text>
            <Text style={styles.tableHeader}>均速</Text>
          </View>
          {typeStats.map(({ type, count, avgKmh, color }) => (
            <View key={type} style={[styles.tableRow, styles.tableDataRow]}>
              <View style={[styles.typeCell, { flex: 2 }]}>
                <View style={[styles.typeDot, { backgroundColor: color }]} />
                <Text style={styles.typeText}>{pitchTypeLabel(type)}</Text>
              </View>
              <Text style={styles.tableData}>{count}</Text>
              <Text style={styles.tableData}>
                {avgKmh !== null ? `${formatSpeed(avgKmh, settings.speedUnit)} ${speedUnitLabel(settings.speedUnit)}` : '—'}
              </Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function BullpenTab({ records }: { records: PitchResult[] }) {
  const { settings } = useSettings();
  const unitLabel = speedUnitLabel(settings.speedUnit);
  const metrics = buildBullpenMetrics(records);
  const avgSpeed = formatSpeed(metrics.avgSpeedKmh, settings.speedUnit);
  const maxSpeed = formatSpeed(metrics.maxSpeedKmh, settings.speedUnit);
  const speedTrend = [...records]
    .sort((a, b) => new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime())
    .flatMap((record, index) => {
      const value = getSpeedKmh(record);
      return value === null ? [] : [{ label: `#${index + 1}`, value: speedValue(value, settings.speedUnit) }];
    });

  const spinValues = records
    .map((r) => r.speed_info?.spin_rpm)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const avgRpm = spinValues.length
    ? Math.round(spinValues.reduce((a, b) => a + b, 0) / spinValues.length)
    : null;

  const summary = generateSessionSummary(records, settings.speedUnit);

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 32 }}>
      <View style={styles.statsRowWrap}>
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{records.length}</Text>
          <Text style={styles.statLabel}>投球數</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={styles.statValue}>{avgSpeed}</Text>
          <Text style={styles.statLabel}>均速 {unitLabel}</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={[styles.statValue, { color: Colors.accent }]}>{maxSpeed}</Text>
          <Text style={styles.statLabel}>最高 {unitLabel}</Text>
        </View>
      </View>

      <View style={styles.analysisGrid}>
        <View style={styles.analysisMetric}>
          <Text style={styles.analysisValue}>{metrics.measurementRate == null ? '—' : `${Math.round(metrics.measurementRate * 100)}%`}</Text>
          <Text style={styles.analysisLabel}>測速完成率</Text>
        </View>
        <View style={styles.analysisMetric}>
          <Text style={styles.analysisValue}>{metrics.speedStdDevKmh == null ? '—' : speedValue(metrics.speedStdDevKmh, settings.speedUnit).toFixed(1)}</Text>
          <Text style={styles.analysisLabel}>球速標準差 · {unitLabel}</Text>
        </View>
        <View style={styles.analysisMetric}>
          <Text style={[styles.analysisValue, metrics.velocityDeltaKmh != null && metrics.velocityDeltaKmh < 0 && { color: Colors.red }]}>
            {metrics.velocityDeltaKmh == null ? '—' : `${speedValue(metrics.velocityDeltaKmh, settings.speedUnit) >= 0 ? '+' : ''}${speedValue(metrics.velocityDeltaKmh, settings.speedUnit).toFixed(1)}`}
          </Text>
          <Text style={styles.analysisLabel}>後半段變化 · {unitLabel}</Text>
        </View>
        <View style={styles.analysisMetric}>
          <Text style={styles.analysisValue}>{metrics.strikeRate == null ? '—' : `${Math.round(metrics.strikeRate * 100)}%`}</Text>
          <Text style={styles.analysisLabel}>好球率 · {metrics.locatedCount} 球</Text>
        </View>
      </View>

      <View style={styles.chartWrap}>
        <TrendChart
          data={speedTrend}
          title="Session 球速趨勢"
          subtitle="依投球時間排列，觀察熱身、穩定度與疲勞變化"
          unit={unitLabel}
        />
      </View>

      {avgRpm !== null && (
        <View style={[styles.card, { marginTop: 0 }]}>
          <Text style={styles.statLabel}>平均轉速</Text>
          <Text style={[styles.statValue, { fontSize: FontSize.xxl, color: '#64c8ff' }]}>
            {avgRpm.toLocaleString()} <Text style={{ fontSize: FontSize.sm, fontWeight: '400' }}>rpm</Text>
          </Text>
        </View>
      )}

      <View style={styles.card}>
        <Text style={styles.sectionTitle}>AI 投球建議</Text>
        <Text style={styles.sectionSub}>本次練習分析</Text>
        <View style={styles.divider} />
        <Text style={styles.coachBody}>{summary}</Text>
      </View>

      {records.length > 0 && (
        <View style={{ marginHorizontal: Spacing.lg }}>
          <Text style={styles.highlightsLabel}>最近投球重點</Text>
          {records.slice(0, 5).map((r, i) => {
            const si = r.speed_info || {};
            const comment = generateCoachingComment(si);
            const type = si.pitch_type && si.pitch_type !== 'Unknown' ? si.pitch_type : null;
            const speed = si.release_speed_kmh
              ? formatSpeed(si.release_speed_kmh, settings.speedUnit)
              : si.initial_speed_kmh
                ? formatSpeed(si.initial_speed_kmh, settings.speedUnit)
                : null;
            return (
              <View key={r.job_id || i} style={styles.highlightItem}>
                <View style={[styles.highlightNum, { backgroundColor: type ? pitchColor(type) : Colors.surface2 }]}>
                  <Text style={styles.highlightNumText}>{records.length - i}</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <View style={styles.highlightMeta}>
                    {speed !== null && <Text style={styles.highlightSpeed}>{speed} {unitLabel}</Text>}
                    {type && <Text style={styles.highlightType}>{pitchTypeLabel(type)}</Text>}
                  </View>
                  <Text style={styles.highlightComment}>{comment}</Text>
                </View>
              </View>
            );
          })}
        </View>
      )}
    </ScrollView>
  );
}

function TunnelTab({ records }: { records: PitchResult[] }) {
  const navigation = useNavigation<any>();
  const { settings } = useSettings();
  const [selected, setSelected] = useState<number[]>(records.length >= 2 ? [0, 1] : records.length ? [0] : []);
  const selectedPitches = selected.map((index) => records[index]);

  const togglePitch = (index: number) => {
    if (selected.includes(index)) {
      setSelected(selected.filter((value) => value !== index));
    } else if (selected.length < 6) {
      setSelected([...selected, index]);
    }
  };

  if (records.length < 2) {
    return (
      <View style={styles.emptyWrap}>
        <Text style={styles.emptyText}>至少需要兩球才能進行球路配對。</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.tunnelContent}>
      <View style={styles.card}>
        <Text style={styles.sectionTitle}>選擇 2–6 球疊加</Text>
        <Text style={styles.sectionSub}>依序加入 A–F；所有軌跡會共用時間軸與鏡頭。</Text>
        <View style={styles.selectionSummary}>
          {selectedPitches.map((pitch, index) => (
            <View key={index} style={styles.selectionSlot}>
              <Text style={[styles.selectionBadge, { backgroundColor: pitchDotColor(index) }]}>{String.fromCharCode(65 + index)}</Text>
              <Text style={styles.selectionText} numberOfLines={1}>
                {pitchTypeLabel(pitch.speed_info?.pitch_type)}
              </Text>
            </View>
          ))}
        </View>
        <TouchableOpacity
          style={[styles.tunnelButton, (selectedPitches.length < 2) && styles.tunnelButtonDisabled]}
          disabled={selectedPitches.length < 2}
          onPress={() => selectedPitches.length >= 2 && navigation.navigate('TrajectorySimulation', {
            pitch: selectedPitches[0],
            comparisonPitches: selectedPitches.slice(1),
            title: '球路配對與 Tunnel',
          })}
          accessibilityRole="button"
          accessibilityState={{ disabled: selectedPitches.length < 2 }}
        >
          <Text style={styles.tunnelButtonText}>開啟互動 Tunnel 回放</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.tunnelList}>
        {records.map((pitch, index) => {
          const slot = selected.indexOf(index);
          const unavailable = slot < 0 && selected.length >= 6;
          const type = pitch.speed_info?.pitch_type;
          const speed = getSpeedKmh(pitch);
          return (
            <TouchableOpacity
              key={pitch.job_id || index}
              style={[styles.tunnelPitch, slot >= 0 && styles.tunnelPitchSelected, unavailable && styles.tunnelPitchUnavailable]}
              onPress={() => togglePitch(index)}
              disabled={unavailable}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: slot >= 0, disabled: unavailable }}
              accessibilityLabel={`第 ${records.length - index} 球，${pitchTypeLabel(type)}`}
            >
              <View style={[styles.typeDot, { backgroundColor: pitchColor(type ?? '') }]} />
              <View style={styles.tunnelPitchCopy}>
                <Text style={styles.tunnelPitchTitle}>第 {records.length - index} 球 · {pitchTypeLabel(type)}</Text>
                <Text style={styles.tunnelPitchMeta}>{speed == null ? '未測得球速' : `${formatSpeed(speed, settings.speedUnit)} ${speedUnitLabel(settings.speedUnit)}`}</Text>
              </View>
              {slot >= 0 && <Text style={[styles.slotBadge, { backgroundColor: pitchDotColor(slot) }]}>{String.fromCharCode(65 + slot)}</Text>}
            </TouchableOpacity>
          );
        })}
      </View>
    </ScrollView>
  );
}

export default function SessionDetailScreen() {
  const { settings } = useSettings();
  const unitLabel = speedUnitLabel(settings.speedUnit);
  const route = useRoute<RouteProp<RouteParams, 'SessionDetail'>>();
  const { session } = route.params;
  const [activeTab, setActiveTab] = useState(TABS[0]);
  const { dateLabel, records } = session;
  const metrics = buildBullpenMetrics(records);
  const avgSpeed = metrics.avgSpeedKmh == null ? null : formatSpeed(metrics.avgSpeedKmh, settings.speedUnit);
  const maxSpeed = metrics.maxSpeedKmh == null ? null : formatSpeed(metrics.maxSpeedKmh, settings.speedUnit);
  const breakValues = records
    .map((r) => r.speed_info?.total_break_cm)
    .filter((v): v is number => v != null && Number.isFinite(v));
  const avgBreak = breakValues.length
    ? (breakValues.reduce((a, b) => a + b, 0) / breakValues.length).toFixed(1)
    : null;
  const strikeRate = metrics.strikeRate == null ? null : Math.round(metrics.strikeRate * 100);

  return (
    <View style={styles.container}>
      <View style={styles.sessionHeader}>
        <Text style={styles.sessionDate}>{dateLabel}</Text>
        <Text style={styles.sessionCount}>{records.length} 球</Text>
      </View>
      <View style={styles.summaryStrip}>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryValue}>{avgSpeed ?? '-'}</Text>
          <Text style={styles.summaryLabel}>均速 {unitLabel}</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={[styles.summaryValue, { color: Colors.accent }]}>{maxSpeed ?? '-'}</Text>
          <Text style={styles.summaryLabel}>最高 {unitLabel}</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryValue}>{avgBreak ?? '-'}</Text>
          <Text style={styles.summaryLabel}>平均位移 cm</Text>
        </View>
        <View style={styles.summaryItem}>
          <Text style={styles.summaryValue}>{strikeRate !== null ? `${strikeRate}%` : '-'}</Text>
          <Text style={styles.summaryLabel}>好球率</Text>
        </View>
      </View>
      <SegmentedTabs tabs={TABS} activeTab={activeTab} onSelect={setActiveTab} />
      <View style={{ flex: 1 }}>
        {activeTab === TABS[0] && <ListTab records={records} />}
        {activeTab === TABS[1] && <GraphTab records={records} />}
        {activeTab === TABS[2] && <BullpenTab records={records} />}
        {activeTab === TABS[3] && <TunnelTab records={records} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },
  sessionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  sessionDate: { fontSize: 26, fontWeight: '900', color: Colors.text },
  sessionCount: { fontSize: FontSize.md, color: Colors.textMuted, fontWeight: '700' },
  summaryStrip: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginHorizontal: Spacing.lg,
    marginBottom: Spacing.xs,
  },
  summaryItem: {
    flex: 1,
    minHeight: 58,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.lg,
    paddingVertical: Spacing.sm,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryValue: {
    fontSize: FontSize.lg,
    fontWeight: '900',
    color: Colors.text,
    lineHeight: 19,
    fontVariant: ['tabular-nums'],
  },
  summaryLabel: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 4,
    textAlign: 'center',
  },
  emptyWrap: { alignItems: 'center', paddingVertical: 48, paddingHorizontal: 24 },
  emptyText: { fontSize: FontSize.md, color: Colors.textMuted },
  card: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.xl,
    padding: Spacing.xl,
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.md,
    ...Shadows.soft,
  },
  sectionTitle: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.text },
  sectionSub: { fontSize: FontSize.sm, color: Colors.textMuted, marginTop: 2 },
  divider: { height: 1, backgroundColor: Colors.border, marginTop: Spacing.md, marginBottom: Spacing.sm },
  tableRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.xs },
  tableDataRow: { borderTopWidth: 1, borderTopColor: Colors.border, paddingVertical: Spacing.sm },
  tableHeader: {
    flex: 1,
    fontSize: FontSize.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    color: Colors.textMuted,
    fontWeight: '800',
    textAlign: 'center',
  },
  tableData: { flex: 1, fontSize: FontSize.md, color: Colors.text, textAlign: 'center' },
  typeCell: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  typeDot: { width: 8, height: 8, borderRadius: 4 },
  typeText: { fontSize: FontSize.md, fontWeight: '600', color: Colors.text },
  statsRowWrap: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginHorizontal: Spacing.lg,
    marginTop: Spacing.md,
    marginBottom: Spacing.sm,
  },
  statBox: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    alignItems: 'center',
  },
  statValue: { fontSize: FontSize.xxl, fontWeight: '900', color: Colors.text, lineHeight: 30, fontVariant: ['tabular-nums'] },
  statLabel: {
    fontSize: FontSize.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: Colors.textMuted,
    marginTop: 2,
  },
  analysisGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginHorizontal: Spacing.lg,
  },
  analysisMetric: {
    flexBasis: '46%',
    flexGrow: 1,
    minHeight: 76,
    justifyContent: 'center',
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    padding: Spacing.md,
  },
  analysisValue: { color: Colors.text, fontSize: FontSize.xxl, fontWeight: '900', fontVariant: ['tabular-nums'] },
  analysisLabel: { color: Colors.textMuted, fontSize: FontSize.xs, fontWeight: '700', marginTop: 4 },
  chartWrap: { marginHorizontal: Spacing.lg },
  coachBody: { fontSize: FontSize.md, color: Colors.text, lineHeight: 24, marginTop: Spacing.sm },
  highlightsLabel: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: Spacing.md,
    marginTop: Spacing.xl,
  },
  highlightItem: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginBottom: Spacing.sm,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.lg,
    padding: Spacing.md,
    paddingHorizontal: Spacing.lg,
    alignItems: 'flex-start',
  },
  highlightNum: {
    width: 26, height: 26, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center',
    flexShrink: 0, marginTop: 1,
  },
  highlightNumText: { fontSize: FontSize.sm, fontWeight: '700', color: '#fff' },
  highlightMeta: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: 3 },
  highlightSpeed: { fontSize: FontSize.md, fontWeight: '700', color: Colors.text },
  highlightType: { fontSize: FontSize.sm, color: Colors.textMuted, fontWeight: '500' },
  highlightComment: { fontSize: FontSize.sm, color: Colors.textMuted, lineHeight: 19 },
  tunnelContent: { paddingBottom: 32 },
  selectionSummary: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginTop: Spacing.lg },
  selectionSlot: { flexBasis: '30%', flexGrow: 1, minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, paddingHorizontal: Spacing.md, borderRadius: Radius.lg, backgroundColor: Colors.surface2, borderWidth: 1, borderColor: Colors.border },
  selectionBadge: { width: 24, height: 24, lineHeight: 24, borderRadius: 12, overflow: 'hidden', textAlign: 'center', color: '#fff', backgroundColor: Colors.accent, fontSize: 12, fontWeight: '900' },
  selectionText: { flex: 1, color: Colors.text, fontSize: FontSize.sm, fontWeight: '800' },
  tunnelButton: { minHeight: 48, marginTop: Spacing.md, borderRadius: Radius.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.accent },
  tunnelButtonDisabled: { opacity: 0.45 },
  tunnelButtonText: { color: '#fff', fontSize: FontSize.md, fontWeight: '900' },
  tunnelList: { marginHorizontal: Spacing.lg, marginTop: Spacing.md, gap: Spacing.sm },
  tunnelPitch: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.lg, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border, backgroundColor: Colors.surface },
  tunnelPitchSelected: { borderColor: Colors.accent, backgroundColor: Colors.accentSubtle },
  tunnelPitchUnavailable: { opacity: 0.4 },
  tunnelPitchCopy: { flex: 1 },
  tunnelPitchTitle: { color: Colors.text, fontSize: FontSize.md, fontWeight: '800' },
  tunnelPitchMeta: { color: Colors.textMuted, fontSize: FontSize.sm, marginTop: 3 },
  slotBadge: { width: 28, height: 28, lineHeight: 28, borderRadius: 14, overflow: 'hidden', textAlign: 'center', color: '#fff', backgroundColor: Colors.accent, fontSize: 13, fontWeight: '900' },
});
