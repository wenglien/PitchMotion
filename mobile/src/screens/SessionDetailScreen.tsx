import React, { useState } from 'react';
import { View, Text, ScrollView, FlatList, StyleSheet } from 'react-native';
import { RouteProp, useNavigation, useRoute } from '@react-navigation/native';
import { Colors, Spacing, Radius, FontSize, Shadows } from '../theme';
import { Session, PitchResult } from '../types';
import { formatSpeed, getSpeedKmh, pitchTypeLabel, speedUnitLabel } from '../utils/conversions';
import {
  buildTypeStats,
  toStrikeZonePitches,
  generateSessionSummary,
  generateCoachingComment,
} from '../utils/coaching';
import { pitchColor } from '../utils/conversions';
import PitchCard from '../components/PitchCard';
import StrikeZone from '../components/StrikeZone';
import SegmentedTabs from '../components/SegmentedTabs';
import { useSettings } from '../context/SettingsContext';

type RouteParams = { SessionDetail: { session: Session } };

const TABS = ['投球列表', '軌跡圖', 'AI 建議'];

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

function AICoachTab({ records }: { records: PitchResult[] }) {
  const { settings } = useSettings();
  const unitLabel = speedUnitLabel(settings.speedUnit);
  const speeds = records
    .map(getSpeedKmh)
    .filter((v): v is number => v !== null)
    .map((kmh) => kmh);

  const avgSpeed = speeds.length
    ? formatSpeed(speeds.reduce((a, b) => a + b, 0) / speeds.length, settings.speedUnit)
    : null;
  const maxSpeed = speeds.length ? formatSpeed(Math.max(...speeds), settings.speedUnit) : null;

  const spinValues = records
    .map((r) => r.speed_info?.spin_rpm)
    .filter((v): v is number => v != null);
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
          <Text style={styles.statValue}>{avgSpeed ?? '—'}</Text>
          <Text style={styles.statLabel}>均速 {unitLabel}</Text>
        </View>
        <View style={styles.statBox}>
          <Text style={[styles.statValue, { color: Colors.accent }]}>{maxSpeed ?? '—'}</Text>
          <Text style={styles.statLabel}>最高 {unitLabel}</Text>
        </View>
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

export default function SessionDetailScreen() {
  const { settings } = useSettings();
  const unitLabel = speedUnitLabel(settings.speedUnit);
  const route = useRoute<RouteProp<RouteParams, 'SessionDetail'>>();
  const { session } = route.params;
  const [activeTab, setActiveTab] = useState(TABS[0]);
  const { dateLabel, records } = session;
  const speeds = records
    .map(getSpeedKmh)
    .filter((v): v is number => v !== null)
    .map((kmh) => kmh);
  const avgSpeed = speeds.length
    ? formatSpeed(speeds.reduce((a, b) => a + b, 0) / speeds.length, settings.speedUnit)
    : null;
  const maxSpeed = speeds.length ? formatSpeed(Math.max(...speeds), settings.speedUnit) : null;
  const breakValues = records
    .map((r) => r.speed_info?.total_break_cm)
    .filter((v): v is number => v != null);
  const avgBreak = breakValues.length
    ? (breakValues.reduce((a, b) => a + b, 0) / breakValues.length).toFixed(1)
    : null;
  const strikeCount = records.filter((r) => r.speed_info?.is_strike === true).length;
  const strikeRate = records.length ? Math.round((strikeCount / records.length) * 100) : null;

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
        {activeTab === TABS[2] && <AICoachTab records={records} />}
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
});
