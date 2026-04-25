import React, { useState, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, ActivityIndicator,
  StyleSheet, Alert,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { Colors, Spacing, Radius, FontSize, Shadows } from '../theme';
import { Session } from '../types';
import { groupIntoSessions } from '../utils/coaching';
import { KMH_TO_MPH, getSpeedKmh } from '../utils/conversions';
import { loadLocalHistory, clearLocalHistory } from '../hooks/useLocalHistory';

export default function HistoryScreen() {
  const navigation = useNavigation<any>();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

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

  const renderSession = ({ item, index }: { item: Session; index: number }) => {
    const { dateLabel, records } = item;
    const speeds = records
      .map(getSpeedKmh)
      .filter((v): v is number => v !== null);
    const avgMph = speeds.length
      ? ((speeds.reduce((a, b) => a + b, 0) / speeds.length) * KMH_TO_MPH).toFixed(1)
      : null;
    const maxMph = speeds.length
      ? (Math.max(...speeds) * KMH_TO_MPH).toFixed(1)
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
          {avgMph !== null && (
            <View style={styles.statItem}>
              <Text style={styles.statValue}>{avgMph}</Text>
              <Text style={styles.statLabel}>均速 mph</Text>
            </View>
          )}
          {maxMph !== null && (
            <View style={styles.statItem}>
              <Text style={[styles.statValue, { color: Colors.accent }]}>{maxMph}</Text>
              <Text style={styles.statLabel}>最高 mph</Text>
            </View>
          )}
        </View>

        {/* Pitch type chips */}
        {types.length > 0 && (
          <View style={styles.typeRow}>
            {types.map((t) => (
              <View key={t} style={styles.typeChip}>
                <Text style={styles.typeChipText}>{t}</Text>
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
        <Text style={styles.emptyTitle}>尚無投球紀錄</Text>
        <Text style={styles.emptyBody}>完成第一次分析後，紀錄會自動儲存在這裡。</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={sessions}
        keyExtractor={(item) => item.dateLabel}
        renderItem={renderSession}
        onRefresh={load}
        refreshing={loading}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <Text style={styles.listHeaderText}>{sessions.length} 次練習</Text>
            <TouchableOpacity onPress={onClearAll} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={styles.clearBtn}>清除全部</Text>
            </TouchableOpacity>
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
  listContent: {
    paddingHorizontal: Spacing.lg,
    paddingBottom: 40,
  },
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
    backgroundColor: Colors.surface,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
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
});
