import React, { useState, useCallback, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, ActivityIndicator,
  StyleSheet, Alert, ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { Colors, Spacing, Radius, FontSize, Shadows, Surfaces } from '../theme';
import { Session } from '../types';
import { groupIntoSessions } from '../utils/coaching';
import { formatSpeed, getSpeedKmh, pitchTypeLabel, speedUnitLabel, speedValue } from '../utils/conversions';
import { loadLocalHistory, clearLocalHistory } from '../hooks/useLocalHistory';
import { useSettings } from '../context/SettingsContext';
import TrendChart from '../components/TrendChart';

type TrendMetric = 'speed' | 'strike' | 'break';

const TREND_METRICS: { id: TrendMetric; label: string }[] = [
  { id: 'speed', label: '平均球速' },
  { id: 'strike', label: '好球率' },
  { id: 'break', label: '平均位移' },
];

export default function HistoryScreen() {
  const navigation = useNavigation<any>();
  const { settings } = useSettings();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [trendMetric, setTrendMetric] = useState<TrendMetric>('speed');
  const [pitchFilter, setPitchFilter] = useState<string>('全部');
  const speedUnit = settings.speedUnit;
  const unitLabel = speedUnitLabel(speedUnit);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await loadLocalHistory();
      setSessions(groupIntoSessions(data));
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload whenever the tab comes into focus
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onClearAll = () => {
    Alert.alert(
      '清除所有記錄',
      '確定要刪除所有投球歷史嗎？此動作無法復原。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '清除',
          style: 'destructive',
          onPress: async () => {
            await clearLocalHistory();
            setSessions([]);
          },
        },
      ],
    );
  };
  const totalPitches = sessions.reduce((sum, session) => sum + session.records.length, 0);
  const allSpeeds = sessions
    .flatMap((session) => session.records)
    .map(getSpeedKmh)
    .filter((v): v is number => v !== null);
  const bestSpeed = allSpeeds.length
    ? formatSpeed(Math.max(...allSpeeds), speedUnit)
    : null;

  const pitchTypes = useMemo(() => Array.from(new Set(
    sessions
      .flatMap((session) => session.records)
      .map((record) => record.speed_info?.pitch_type)
      .filter((type): type is string => !!type && type !== 'Unknown'),
  )), [sessions]);

  const filteredSessions = useMemo(() => sessions
    .map((session) => ({
      ...session,
      records: pitchFilter === '全部'
        ? session.records
        : session.records.filter((record) => record.speed_info?.pitch_type === pitchFilter),
    }))
    .filter((session) => session.records.length > 0), [sessions, pitchFilter]);

  const trendData = useMemo(() => filteredSessions.slice(0, 10).reverse().flatMap((session) => {
    const records = session.records;
    let value: number | null = null;
    if (trendMetric === 'speed') {
      const values = records.map(getSpeedKmh).filter((item): item is number => item !== null);
      value = values.length ? speedValue(values.reduce((sum, item) => sum + item, 0) / values.length, speedUnit) : null;
    } else if (trendMetric === 'strike') {
      const known = records.filter((record) => typeof record.speed_info?.is_strike === 'boolean');
      value = known.length ? (known.filter((record) => record.speed_info?.is_strike).length / known.length) * 100 : null;
    } else {
      const values = records
        .map((record) => record.speed_info?.total_break_cm)
        .filter((item): item is number => item != null);
      value = values.length ? values.reduce((sum, item) => sum + item, 0) / values.length : null;
    }
    return value == null ? [] : [{ label: session.dateLabel.slice(5), value }];
  }), [filteredSessions, speedUnit, trendMetric]);

  const trendMeta = trendMetric === 'speed'
    ? { title: '平均球速趨勢', subtitle: `最近 ${trendData.length} 次有速度資料的練習`, unit: unitLabel, color: Colors.accent }
    : trendMetric === 'strike'
      ? { title: '好球率趨勢', subtitle: `最近 ${trendData.length} 次有落點資料的練習`, unit: '%', color: Colors.green }
      : { title: '平均位移趨勢', subtitle: `最近 ${trendData.length} 次有位移資料的練習`, unit: 'cm', color: Colors.accent2 };

  const renderSession = ({ item, index }: { item: Session; index: number }) => {
    const { dateLabel, records } = item;
    const speeds = records
      .map(getSpeedKmh)
      .filter((v): v is number => v !== null);
    const avgSpeed = speeds.length
      ? formatSpeed(speeds.reduce((a, b) => a + b, 0) / speeds.length, speedUnit)
      : null;
    const maxSpeed = speeds.length
      ? formatSpeed(Math.max(...speeds), speedUnit)
      : null;

    // Collect unique pitch types
    const types = Array.from(
      new Set(
        records
          .map((r) => r.speed_info?.pitch_type)
          .filter((t): t is string => !!t && t !== 'Unknown'),
      ),
    ).slice(0, 3);

    return (
      <TouchableOpacity
        style={[styles.card, index === 0 && styles.cardFirst]}
        onPress={() => navigation.navigate('SessionDetail', { session: item })}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`${dateLabel} 練習，共 ${records.length} 球${avgSpeed ? `，均速 ${avgSpeed} ${unitLabel}` : ''}${maxSpeed ? `，最高 ${maxSpeed} ${unitLabel}` : ''}`}
        accessibilityHint="點擊查看詳細投球紀錄"
      >
        {/* Date row */}
        <View style={styles.cardHeader}>
          <Text style={styles.cardDate}>{dateLabel}</Text>
          <Text style={styles.cardArrow}>›</Text>
        </View>

        {/* Stats row */}
        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{records.length}</Text>
            <Text style={styles.statLabel}>投球</Text>
          </View>
          {avgSpeed !== null && (
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{avgSpeed}</Text>
              <Text style={styles.statLabel}>均速 {unitLabel}</Text>
            </View>
          )}
          {maxSpeed !== null && (
            <View style={styles.statItem}>
              <Text style={[styles.statValue, { color: Colors.accent }]}>{maxSpeed}</Text>
              <Text style={styles.statLabel}>最高 {unitLabel}</Text>
            </View>
          )}
        </View>

        {/* Pitch type chips */}
        {types.length > 0 && (
          <View style={styles.typeRow}>
            {types.map((t) => (
              <View key={t} style={styles.typeChip}>
                <Text style={styles.typeChipText}>{pitchTypeLabel(t)}</Text>
              </View>
            ))}
          </View>
        )}
      </TouchableOpacity>
    );
  };

  if (loading && sessions.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={Colors.accent} />
      </View>
    );
  }

  if (!loading && sessions.length === 0) {
    return (
      <View style={styles.centered}>
        <View style={styles.emptyIcon}>
          <Ionicons name="time-outline" size={28} color={Colors.accent} />
        </View>
        <Text style={styles.emptyTitle}>尚無投球紀錄</Text>
        <Text style={styles.emptyBody}>完成第一次分析後，紀錄會自動儲存在這裡。</Text>
        <TouchableOpacity
          style={styles.emptyAction}
          onPress={() => navigation.getParent()?.navigate('Analyze')}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel="前往分析頁面"
        >
          <Ionicons name="videocam-outline" size={18} color="#fff" />
          <Text style={styles.emptyActionText}>開始分析</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={filteredSessions}
        keyExtractor={(item) => item.dateLabel}
        renderItem={renderSession}
        onRefresh={load}
        refreshing={loading}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View>
            <View style={styles.summaryCard}>
              <View style={styles.summaryHeader}>
                <View>
                  <Text style={styles.summaryEyebrow}>練習分析</Text>
                  <Text style={styles.summaryTitle}>練習紀錄</Text>
                </View>
                <Ionicons name="bar-chart-outline" size={22} color={Colors.textMuted} />
              </View>
              <View style={styles.summaryGrid}>
                <View style={styles.summaryItem}>
                  <Text style={styles.summaryValue}>{sessions.length}</Text>
                  <Text style={styles.summaryLabel}>練習</Text>
                </View>
                <View style={styles.summaryItem}>
                  <Text style={styles.summaryValue}>{totalPitches}</Text>
                  <Text style={styles.summaryLabel}>投球</Text>
                </View>
                <View style={styles.summaryItem}>
                  <Text style={[styles.summaryValue, { color: Colors.accent }]}>{bestSpeed ?? '-'}</Text>
                  <Text style={styles.summaryLabel}>最佳 {unitLabel}</Text>
                </View>
              </View>
            </View>
            <View style={styles.trendControls}>
              <Text style={styles.controlTitle}>查看趨勢</Text>
              <View style={styles.metricRow}>
                {TREND_METRICS.map((metric) => {
                  const selected = trendMetric === metric.id;
                  return (
                    <TouchableOpacity
                      key={metric.id}
                      style={[styles.metricButton, selected && styles.metricButtonActive]}
                      onPress={() => setTrendMetric(metric.id)}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                    >
                      <Text style={[styles.metricButtonText, selected && styles.metricButtonTextActive]}>{metric.label}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={[styles.controlTitle, { marginTop: Spacing.md }]}>球種篩選</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
                {['全部', ...pitchTypes].map((type) => {
                  const selected = pitchFilter === type;
                  return (
                    <TouchableOpacity
                      key={type}
                      style={[styles.filterChip, selected && styles.filterChipActive]}
                      onPress={() => setPitchFilter(type)}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                    >
                      <Text style={[styles.filterChipText, selected && styles.filterChipTextActive]}>
                        {type === '全部' ? type : pitchTypeLabel(type)}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </View>
            <TrendChart
              data={trendData}
              title={trendMeta.title}
              subtitle={trendMeta.subtitle}
              unit={trendMeta.unit}
              color={trendMeta.color}
            />
            <View style={styles.listHeader}>
              <Text style={styles.listHeaderText}>{pitchFilter === '全部' ? '最近練習' : `${pitchTypeLabel(pitchFilter)}練習`}</Text>
              <TouchableOpacity
                onPress={onClearAll}
                hitSlop={{ top: 12, bottom: 12, left: 16, right: 16 }}
                accessibilityRole="button"
                accessibilityLabel="清除所有歷史投球紀錄"
                accessibilityHint="此動作無法復原"
              >
                <Text style={styles.clearBtn}>清除全部</Text>
              </TouchableOpacity>
            </View>
          </View>
        }
        ListEmptyComponent={
          <View style={styles.filteredEmpty}>
            <Text style={styles.filteredEmptyText}>這個球種目前沒有練習紀錄。</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    backgroundColor: Colors.bg,
  },
  emptyTitle: {
    fontSize: FontSize.xl,
    fontWeight: '600',
    color: Colors.text,
    marginBottom: Spacing.sm,
  },
  emptyBody: {
    fontSize: FontSize.md,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
  emptyIcon: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(14,165,233,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(14,165,233,0.22)',
    marginBottom: Spacing.md,
  },
  emptyAction: {
    minHeight: 46,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.accent,
    borderRadius: Radius.xl,
    paddingHorizontal: Spacing.xl,
    marginTop: Spacing.lg,
  },
  emptyActionText: {
    color: '#fff',
    fontSize: FontSize.md,
    fontWeight: '800',
  },
  listContent: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: 40,
  },
  summaryCard: {
    ...Surfaces.card,
    marginTop: Spacing.lg,
    ...Shadows.soft,
  },
  summaryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
    marginBottom: Spacing.md,
  },
  summaryEyebrow: {
    fontSize: FontSize.xs,
    fontWeight: '900',
    color: Colors.textMuted,
    letterSpacing: 0.8,
    marginBottom: 3,
  },
  summaryTitle: {
    fontSize: FontSize.xl,
    fontWeight: '900',
    color: Colors.text,
  },
  summaryGrid: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  summaryItem: {
    flex: 1,
    minHeight: 62,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.xs,
  },
  summaryValue: {
    fontSize: FontSize.xl,
    lineHeight: 24,
    fontWeight: '900',
    color: Colors.text,
    fontVariant: ['tabular-nums'],
  },
  summaryLabel: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    fontWeight: '800',
    marginTop: 4,
  },
  trendControls: {
    marginTop: Spacing.lg,
  },
  controlTitle: {
    color: Colors.textMuted,
    fontSize: FontSize.sm,
    fontWeight: '800',
    marginBottom: Spacing.sm,
  },
  metricRow: {
    flexDirection: 'row',
    gap: Spacing.xs,
  },
  metricButton: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.xs,
  },
  metricButtonActive: {
    borderColor: Colors.accent,
    backgroundColor: Colors.accentSubtle,
  },
  metricButtonText: {
    color: Colors.textMuted,
    fontSize: FontSize.sm,
    fontWeight: '800',
  },
  metricButtonTextActive: { color: Colors.accent },
  filterRow: {
    gap: Spacing.xs,
    paddingRight: Spacing.lg,
  },
  filterChip: {
    minHeight: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
  },
  filterChipActive: {
    borderColor: Colors.accent,
    backgroundColor: Colors.accent,
  },
  filterChipText: {
    color: Colors.textMuted,
    fontSize: FontSize.sm,
    fontWeight: '800',
  },
  filterChipTextActive: { color: Colors.onAccent },
  listHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: Spacing.lg,
    paddingBottom: Spacing.md,
  },
  listHeaderText: {
    fontSize: FontSize.sm,
    fontWeight: '600',
    color: Colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  clearBtn: {
    fontSize: FontSize.sm,
    color: Colors.red,
    fontWeight: '500',
  },
  card: {
    ...Surfaces.card,
    marginBottom: Spacing.md,
    ...Shadows.soft,
  },
  cardFirst: {
    borderColor: Colors.accent,
    backgroundColor: '#f8fbff',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  cardDate: {
    fontSize: FontSize.lg,
    fontWeight: '800',
    color: Colors.text,
  },
  cardArrow: {
    fontSize: 20,
    color: Colors.textMuted,
  },
  statsRow: {
    flexDirection: 'row',
    gap: Spacing.lg,
    marginBottom: Spacing.sm,
  },
  statItem: {
    alignItems: 'flex-start',
  },
  statValue: {
    fontSize: FontSize.xxl,
    fontWeight: '900',
    color: Colors.text,
    lineHeight: 28,
  },
  statLabel: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 1,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  typeRow: {
    flexDirection: 'row',
    gap: Spacing.xs,
    marginTop: Spacing.sm,
    flexWrap: 'wrap',
  },
  typeChip: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  typeChipText: {
    fontSize: FontSize.xs,
    fontWeight: '600',
    color: Colors.textMuted,
  },
  filteredEmpty: {
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filteredEmptyText: {
    color: Colors.textMuted,
    fontSize: FontSize.md,
  },
});
