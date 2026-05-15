import React, { useRef, useEffect } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Colors } from '../theme';
import { STAGES, stageIndex } from '../utils/pipelineStages';
import ProgressRing from './ProgressRing';

interface RawLogEntry {
  msg: string;
  isError: boolean;
}

interface Props {
  uploadPct: number;
  stageId: string | null;
  stageMessages: string[];
  rawLogs: RawLogEntry[];
  showRaw: boolean;
}

export default function AnalysisProgress({ uploadPct, stageId, stageMessages, rawLogs, showRaw }: Props) {
  const currentIdx = stageIndex(stageId || 'upload');
  const logScrollRef = useRef<ScrollView>(null);
  const lastMsg = stageMessages[stageMessages.length - 1] || '';

  useEffect(() => {
    logScrollRef.current?.scrollToEnd({ animated: true });
  }, [stageMessages]);

  return (
    <View style={styles.card}>
      {/* Header with progress ring */}
      <View style={styles.header}>
        <ProgressRing
          pct={uploadPct < 100 ? uploadPct : Math.round(((currentIdx + 0.5) / STAGES.length) * 100)}
          isUpload={uploadPct < 100}
          stageColor={STAGES[Math.max(0, currentIdx)]?.color}
        />
        <View style={styles.headerText}>
          <Text style={styles.title}>
            {uploadPct < 100 ? '上傳影片中' : (STAGES[currentIdx]?.label ?? '分析中')}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {uploadPct < 100
              ? `${uploadPct}% 已上傳`
              : (lastMsg || STAGES[currentIdx]?.sublabel || '處理中…')}
          </Text>
        </View>
      </View>

      {/* Stage list */}
      <View style={styles.stageList}>
        {STAGES.slice(0, -1).map((stage, i) => {
          const state =
            i < currentIdx ? 'done' :
            i === currentIdx ? 'active' :
            'pending';
          const isLast = i >= STAGES.length - 2;

          return (
            <View key={stage.id} style={styles.stageItem}>
              {/* Marker column: dot + connector line */}
              <View style={styles.markerCol}>
                <View
                  style={[
                    styles.dot,
                    state === 'done' && styles.dotDone,
                    state === 'active' && styles.dotActive,
                  ]}
                >
                  {state === 'done' && <Text style={styles.dotCheck}>✓</Text>}
                  {state === 'active' && <View style={styles.dotPulse} />}
                </View>
                {!isLast && (
                  <View style={[styles.line, state === 'done' && styles.lineDone]} />
                )}
              </View>

              {/* Content column */}
              <View style={styles.contentCol}>
                <View style={styles.stageRow}>
                  <Text
                    style={[
                      styles.stageLabel,
                      state === 'done' && { color: '#16a34a' },
                      state === 'active' && { color: Colors.text },
                      state === 'pending' && { color: Colors.textMuted },
                    ]}
                  >
                    {stage.label}
                  </Text>
                  {state === 'done' && (
                    <Text style={[styles.stageStatus, { color: '#16a34a' }]}>完成</Text>
                  )}
                  {state === 'active' && (
                    <Text style={[styles.stageStatus, { color: Colors.accent }]}>進行中</Text>
                  )}
                </View>
                {state === 'active' && lastMsg ? (
                  <Text style={styles.stageDetail} numberOfLines={2}>{lastMsg}</Text>
                ) : null}
              </View>
            </View>
          );
        })}
      </View>

      {/* Raw logs */}
      {showRaw && rawLogs.length > 0 && (
        <View style={styles.rawSection}>
          <ScrollView
            ref={logScrollRef}
            style={styles.rawBody}
            nestedScrollEnabled
            scrollEnabled
            showsVerticalScrollIndicator
          >
            {rawLogs.map((entry, i) => (
              <Text
                key={i}
                style={[styles.rawLine, entry.isError && styles.rawError]}
              >
                {entry.msg}
              </Text>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 20,
    padding: 20,
    paddingBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 12,
    elevation: 3,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingBottom: 18,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    marginBottom: 16,
  },
  headerText: {
    flex: 1,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: Colors.text,
    lineHeight: 22,
  },
  subtitle: {
    fontSize: 13,
    color: Colors.textMuted,
    marginTop: 3,
    lineHeight: 18,
  },
  stageList: {
    gap: 0,
  },
  stageItem: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  markerCol: {
    width: 22,
    alignItems: 'center',
  },
  contentCol: {
    flex: 1,
    paddingBottom: 6,
  },
  dot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: Colors.surface2,
    borderWidth: 2,
    borderColor: Colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  dotDone: {
    backgroundColor: '#16a34a',
    borderColor: '#16a34a',
  },
  dotActive: {
    backgroundColor: Colors.surface,
    borderColor: Colors.accent,
  },
  dotPulse: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.accent,
  },
  dotCheck: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '900',
    lineHeight: 10,
  },
  stageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 0,
    minHeight: 18,
  },
  line: {
    flex: 1,
    width: 2,
    marginTop: 2,
    marginBottom: 2,
    backgroundColor: Colors.border,
  },
  lineDone: {
    backgroundColor: '#16a34a',
  },
  stageLabel: {
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 18,
    flexShrink: 1,
  },
  stageStatus: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
    marginLeft: 8,
  },
  stageDetail: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 2,
    lineHeight: 16,
  },
  rawSection: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingTop: 10,
  },
  rawBody: {
    backgroundColor: '#f8f9fb',
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    padding: 10,
    maxHeight: 180,
  },
  rawLine: {
    fontFamily: 'Courier',
    fontSize: 10.5,
    lineHeight: 18,
    color: '#555e6e',
  },
  rawError: {
    color: '#dc2626',
  },
});
