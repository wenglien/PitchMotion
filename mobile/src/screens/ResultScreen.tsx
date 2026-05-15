import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Linking, Alert, useWindowDimensions } from 'react-native';
import * as Sharing from 'expo-sharing';
import { Colors, Spacing, Radius, FontSize, Layout, Shadows } from '../theme';
import VideoPlayer from '../components/VideoPlayer';
import { useResult } from '../context/ResultContext';
import { useSettings } from '../context/SettingsContext';
import { kmhToMph, pitchColor, shortMethod } from '../utils/conversions';
import StrikeZone from '../components/StrikeZone';
import BreakChart from '../components/BreakChart';
import { friendlyError } from '../utils/errors';
import SegmentedTabs from '../components/SegmentedTabs';
import { useNavigation } from '@react-navigation/native';

const VIDEO_TAB_OVERLAY = '分析疊圖';
const VIDEO_TAB_ORIGINAL = '原始錄影';

function resolveUriHelper(url: string | undefined, baseUrl: string): string | null {
  if (!url) return null;
  if (url.startsWith('file://') || url.startsWith('/')) return url;
  if (url.startsWith('http')) return url;
  if (!baseUrl) return null;  // can't resolve a relative backend path without a base
  return `${baseUrl}${url.replace(/^https?:\/\/[^/]+/, '')}`;
}

export default function ResultScreen() {
  const { width } = useWindowDimensions();
  const { result, sessionPitches, clearPitches, analysisLogs } = useResult();
  const { settings } = useSettings();
  const navigation = useNavigation<any>();
  const [showLogs, setShowLogs] = useState(false);
  const [videoTab, setVideoTab] = useState<string>(VIDEO_TAB_OVERLAY);
  const logScrollRef = useRef<ScrollView>(null);

  if (!result) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyTitle}>尚無分析結果</Text>
        <Text style={styles.emptySubtitle}>
          前往 <Text style={{ fontWeight: '700', color: Colors.accent }}>分析</Text> 頁面上傳影片開始分析。
        </Text>
      </View>
    );
  }

  const si = result.speed_info || {};
  const primaryKmh = si.release_speed_kmh ?? si.initial_speed_kmh ?? null;
  const primaryMph = primaryKmh !== null ? kmhToMph(primaryKmh) : null;
  const maxKmh = si.max_speed_kmh ?? null;
  const distM = si.total_distance_m ?? si.effective_distance_m ?? null;
  const flightS = si.flight_time_s ?? null;
  const breakH = si.horizontal_break_cm ?? null;
  const breakVInduced = si.induced_vertical_break_cm ?? null;
  const breakTotal = si.total_break_cm ?? null;
  const breakConf = si.break_confidence ?? null;
  const hasBreakChart = breakH !== null && breakVInduced !== null;

  const physClamped = si.physics_clamped ?? false;
  const pitchType = si.pitch_type && si.pitch_type !== 'Unknown' ? si.pitch_type : null;
  const pitchConf = si.pitch_confidence ? Math.round(si.pitch_confidence * 100) : null;
  const method = shortMethod(si.calculation_method);
  const hasWarn = !!si.trajectory_quality_warning;
  const panelWidth = Math.min(width - 32, Layout.maxWidth);
  const speedFontSize = width < 380 ? 66 : 82;

  const baseUrl = settings.backendUrl;

  // Stable identity so StrikeZone / VideoPlayer don't see new prop refs on
  // unrelated re-renders (e.g. log toggle, tab switch).
  const overlayUrl = useMemo(
    () => resolveUriHelper(result.overlay_uri || result.overlay_url, baseUrl),
    [result.overlay_uri, result.overlay_url, baseUrl],
  );
  const originalUrl = useMemo(
    () => resolveUriHelper(result.original_url, baseUrl),
    [result.original_url, baseUrl],
  );
  const hasOverlay = !!overlayUrl && !overlayUrl.includes('/dev/');
  const hasOriginal = !!originalUrl;
  const showOverlayTab = hasOverlay && videoTab === VIDEO_TAB_OVERLAY;
  const activeVideoUrl = showOverlayTab ? overlayUrl : (hasOriginal ? originalUrl : overlayUrl);
  const videoAspectRatio = result.video_width && result.video_height
    ? result.video_width / result.video_height
    : 16 / 9;

  const plateZone = si.plate_zone ?? null;
  const zoneOverride = useMemo(
    () => plateZone
      ? { xMin: plateZone.x_min, xMax: plateZone.x_max, yMin: plateZone.y_min, yMax: plateZone.y_max }
      : null,
    [plateZone?.x_min, plateZone?.x_max, plateZone?.y_min, plateZone?.y_max],
  );

  const handleDownload = useCallback(async () => {
    const target = activeVideoUrl;
    if (!target) return;
    const dialogTitle = showOverlayTab ? '儲存分析影片' : '儲存原始影片';
    try {
      if (target.startsWith('file://') || target.startsWith('/')) {
        const fileUri = target.startsWith('/') ? `file://${target}` : target;
        await Sharing.shareAsync(fileUri, { mimeType: 'video/mp4', dialogTitle });
      } else {
        const downloadUrl = target.replace('/overlays/', '/download/');
        await Sharing.shareAsync(downloadUrl, { mimeType: 'video/mp4', dialogTitle });
      }
    } catch (e) {
      const msg = friendlyError(e, { action: '儲存影片' }) ?? '儲存失敗';
      if (target.startsWith('http')) {
        Linking.openURL(target).catch(() => Alert.alert('下載失敗', msg));
      } else {
        Alert.alert('分享失敗', msg);
      }
    }
  }, [activeVideoUrl, showOverlayTab]);

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>

      {/* ── Hero Card ─────────────────────────────────────── */}
      <View style={[styles.heroCard, { width: panelWidth }]}>
        {/* Pitch type badge row */}
        {pitchType && (
          <View style={styles.badgeRow}>
            <View style={[styles.typeBadge, { backgroundColor: pitchColor(pitchType) }]}>
              <Text style={styles.typeBadgeText}>{pitchType}</Text>
            </View>
            {pitchConf !== null && (
              <Text style={styles.confText}>{pitchConf}% 信心</Text>
            )}
          </View>
        )}

        {/* Big speed number */}
        <View
          style={styles.speedWrap}
          accessible
          accessibilityLabel={
            primaryMph !== null
              ? `球速 ${primaryMph} mph，約等於 ${primaryKmh?.toFixed(1)} 公里每小時`
              : '無法計算球速'
          }
        >
          {primaryMph !== null ? (
            <>
              <Text style={[styles.speedNum, { fontSize: speedFontSize, lineHeight: speedFontSize }]}>{primaryMph}</Text>
              <View style={styles.speedMeta}>
                <Text style={styles.speedUnit}>mph</Text>
                <Text style={styles.speedKmh}>{primaryKmh?.toFixed(1)} km/h</Text>
              </View>
            </>
          ) : (
            <Text style={styles.speedNA}>無法計算球速</Text>
          )}
        </View>

        {/* Divider */}
        <View style={styles.heroDivider} />

        {/* Stats row */}
        <View style={styles.statsGrid}>
          <View style={styles.statItem}>
            <Text style={styles.statVal}>
              {maxKmh !== null ? kmhToMph(maxKmh) : '—'}
            </Text>
            <Text style={styles.statLbl}>最高 mph</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statVal}>
              {distM !== null ? distM.toFixed(1) : '—'}
            </Text>
            <Text style={styles.statLbl}>距離 m</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={styles.statVal}>
              {flightS !== null ? flightS.toFixed(3) : '—'}
            </Text>
            <Text style={styles.statLbl}>飛行 s</Text>
          </View>
        </View>

        {/* Method + quality chips */}
        <View style={styles.chipRow}>
          {method ? (
            <View style={styles.methodChip}>
              <Text style={styles.methodText}>{method}</Text>
            </View>
          ) : null}
          {hasWarn && (
            <View style={styles.warnChip}>
              <Text style={styles.warnChipText}>軌跡品質警告</Text>
            </View>
          )}
          {physClamped && (
            <View style={styles.warnChip}>
              <Text style={styles.warnChipText}>速度推估值</Text>
            </View>
          )}
        </View>
      </View>


      {/* ── Strike Zone ───────────────────────────────────── */}
      <View style={[styles.card, { width: panelWidth }]}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>好球帶落點</Text>
          <Text style={styles.cardSub}>本次練習 {sessionPitches.length} 球</Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.visualWrap}>
          <StrikeZone pitches={sessionPitches} zoneOverride={zoneOverride} />
        </View>
        {sessionPitches.length > 0 && (
          <TouchableOpacity
            style={styles.clearBtn}
            onPress={() => {
              Alert.alert(
                '清除本次投球記錄？',
                `將從本次練習中移除 ${sessionPitches.length} 球的好球帶軌跡，但歷史紀錄仍會保留。`,
                [
                  { text: '取消', style: 'cancel' },
                  { text: '清除', style: 'destructive', onPress: clearPitches },
                ],
              );
            }}
            activeOpacity={0.7}
            hitSlop={{ top: 8, bottom: 8, left: 12, right: 12 }}
            accessibilityRole="button"
            accessibilityLabel="清除本次投球的好球帶記錄"
          >
            <Text style={styles.clearBtnText}>清除投球記錄</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* ── Break Analysis ────────────────────────────────── */}
      {hasBreakChart && (
        <View style={[styles.card, { width: panelWidth }]}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>球路動態分析</Text>
            <Text style={styles.cardSub}>位移 Break</Text>
          </View>
          <View style={styles.divider} />

          {/* Break block — MLB-style X/Y chart */}
          {hasBreakChart && (
            <View style={styles.kineBlock}>
              <View style={styles.kineHeaderRow}>
                <Text style={styles.kineSectionTitle}>位移 (Break)</Text>
                {breakConf !== null && (
                  <Text style={styles.kineConfPill}>
                    可信度 {Math.round(breakConf * 100)}%
                  </Text>
                )}
              </View>
              <View style={styles.breakChartWrap}>
                <BreakChart
                  horizontalCm={breakH!}
                  inducedVerticalCm={breakVInduced!}
                  pitchType={pitchType}
                  confidence={breakConf ?? 0.6}
                />
              </View>
              {breakTotal !== null && (
                <Text style={styles.breakTotalHint}>
                  總位移 <Text style={styles.breakTotalVal}>{breakTotal.toFixed(1)}</Text> cm
                </Text>
              )}
            </View>
          )}

        </View>
      )}

      {/* ── Video Player ──────────────────────────────────── */}
      {(hasOverlay || hasOriginal) && activeVideoUrl && (
        <View style={[styles.videoCard, { width: panelWidth }]}>
          <View style={styles.videoCardHeader}>
            <View style={styles.videoTitleWrap}>
              <Text style={styles.cardTitle}>分析影片</Text>
              <Text style={styles.cardSub}>
                {showOverlayTab ? '含軌跡與標註' : '無標註版本'}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.downloadBtn}
              onPress={handleDownload}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel={showOverlayTab ? '儲存分析疊圖影片到相簿或檔案' : '儲存原始錄影到相簿或檔案'}
            >
              <Text style={styles.downloadBtnText}>儲存</Text>
            </TouchableOpacity>
          </View>

          {hasOverlay && hasOriginal && (
            <View style={styles.videoTabsWrap}>
              <SegmentedTabs
                tabs={[VIDEO_TAB_OVERLAY, VIDEO_TAB_ORIGINAL]}
                activeTab={videoTab}
                onSelect={setVideoTab}
              />
            </View>
          )}

          <VideoPlayer
            key={activeVideoUrl}
            uri={activeVideoUrl}
            aspectRatio={videoAspectRatio}
            style={styles.videoPlayer}
          />

          {showOverlayTab && (
            <Text style={styles.videoHint}>
              提示：若畫面全黑或無法播放，可點「儲存」以本機播放器開啟。
            </Text>
          )}
        </View>
      )}

      {/* ── 分析詳情（給使用者的精簡版；__DEV__ 顯示完整內部數值） ── */}
      {result.yolo_ball_in_frame_count !== undefined && (
        <View style={[styles.card, { width: panelWidth }]}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>分析詳情</Text>
            <Text style={styles.cardSub}>影片資訊與偵測品質</Text>
          </View>
          <View style={styles.divider} />
          <View style={styles.detailGrid}>
            {/* User-meaningful summary */}
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>影片解析度</Text>
              <Text style={styles.detailValue}>
                {result.video_width && result.video_height
                  ? `${result.video_width} × ${result.video_height}`
                  : '—'}
              </Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>幀率（FPS）</Text>
              <Text style={styles.detailValue}>{result.fps ?? '—'}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>偵測到球的幀數</Text>
              <Text style={[styles.detailValue, { color: (result.yolo_raw_detection_frames ?? 0) > 0 ? Colors.green : Colors.red }]}>
                {result.yolo_raw_detection_frames ?? '—'}
                {result.total_frames ? ` / ${result.total_frames}` : ''}
              </Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>軌跡點數</Text>
              <Text style={styles.detailValue}>{result.trajectory_count ?? '—'}</Text>
            </View>

            {/* Internal frame-index data — dev only */}
            {__DEV__ && (
              <>
                <View style={styles.divider} />
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>YOLO 處理幀（dev）</Text>
                  <Text style={styles.detailValue}>{result.yolo_frames_processed ?? '—'}</Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>YOLO 偵測總次數（dev）</Text>
                  <Text style={styles.detailValue}>{result.yolo_total_detections ?? '—'}</Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>球在幀中 Phase1（dev）</Text>
                  <Text style={[styles.detailValue, { color: result.yolo_ball_in_frame_count! > 0 ? Colors.green : Colors.red }]}>
                    {result.yolo_ball_in_frame_count ?? '—'}
                  </Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>出手幀（dev）</Text>
                  <Text style={styles.detailValue}>
                    {si.release_frame_idx != null
                      ? `${si.release_frame_idx}${si.release_frame_source === 'fallback' ? ' (估)' : ' (Pose)'}`
                      : '—'}
                  </Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>第一顆球幀（dev）</Text>
                  <Text style={styles.detailValue}>{si.first_ball_frame_idx ?? '—'}</Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>接球幀（dev）</Text>
                  <Text style={styles.detailValue}>{si.catch_frame_idx ?? '—'}</Text>
                </View>
              </>
            )}
          </View>
        </View>
      )}

      {/* ── Console Log (dev only — noisy raw pipeline output) ─── */}
      {__DEV__ && analysisLogs.length > 0 && (
        <View style={[styles.card, { width: panelWidth }]}>
          <TouchableOpacity
            style={styles.logHeader}
            onPress={() => {
              setShowLogs((v) => {
                if (!v) {
                  setTimeout(() => logScrollRef.current?.scrollToEnd({ animated: false }), 100);
                }
                return !v;
              });
            }}
            activeOpacity={0.7}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel={showLogs ? '收起分析 Log' : '展開分析 Log'}
          >
            <Text style={styles.cardTitle}>分析 Log（dev）</Text>
            <Text style={styles.logToggleText}>
              {showLogs ? '▲ 收起' : '▼ 展開'}
            </Text>
          </TouchableOpacity>
          {showLogs && (
            <>
              <View style={styles.divider} />
              <ScrollView
                ref={logScrollRef}
                style={styles.logBody}
                nestedScrollEnabled
                showsVerticalScrollIndicator
                onContentSizeChange={() => logScrollRef.current?.scrollToEnd({ animated: false })}
              >
                {analysisLogs.map((entry, i) => (
                  <Text
                    key={i}
                    style={[styles.logLine, entry.isError && styles.logError]}
                  >
                    {entry.msg}
                  </Text>
                ))}
              </ScrollView>
            </>
          )}
        </View>
      )}

      {/* ── CTA ───────────────────────────────────────────── */}
      <View style={[styles.ctaWrap, { width: panelWidth }]}>
        <TouchableOpacity
          style={styles.ctaBtn}
          onPress={() => navigation.navigate('Analyze')}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="回到分析頁面，分析下一顆球"
        >
          <Text style={styles.ctaBtnText}>再分析一顆</Text>
        </TouchableOpacity>
      </View>

    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: Colors.bg },
  content: { paddingTop: Spacing.md, paddingBottom: 40, alignItems: 'center' },

  emptyContainer: {
    flex: 1,
    backgroundColor: Colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: { fontSize: FontSize.xl, fontWeight: '600', color: Colors.text, marginBottom: Spacing.sm },
  emptySubtitle: { fontSize: FontSize.md, color: Colors.textMuted, textAlign: 'center', lineHeight: 22 },

  /* Hero */
  heroCard: {
    backgroundColor: Colors.panel,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: Radius.xxl,
    paddingHorizontal: Spacing.xl,
    paddingTop: Spacing.xl,
    paddingBottom: Spacing.lg,
    ...Shadows.card,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  typeBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 99,
  },
  typeBadgeText: { fontSize: FontSize.sm, fontWeight: '700', color: '#fff' },
  confText: { fontSize: FontSize.sm, color: Colors.textMuted },

  speedWrap: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  speedNum: {
    fontWeight: '800',
    letterSpacing: 0,
    color: Colors.textInverse,
  },
  speedMeta: { paddingBottom: 10, gap: 2 },
  speedUnit: {
    fontSize: FontSize.xxl,
    fontWeight: '600',
    color: '#94a3b8',
    lineHeight: FontSize.xxl + 2,
  },
  speedKmh: { fontSize: FontSize.md, color: '#94a3b8' },
  speedNA: { fontSize: FontSize.xl, color: '#94a3b8', paddingVertical: 24 },

  heroDivider: { height: 1, backgroundColor: 'rgba(255,255,255,0.1)', marginVertical: Spacing.md },

  statsGrid: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
  },
  statItem: {
    flex: 1,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: Radius.lg,
    paddingVertical: Spacing.md,
  },
  statVal: { fontSize: FontSize.xl, fontWeight: '800', color: Colors.textInverse, fontVariant: ['tabular-nums'] },
  statLbl: {
    fontSize: FontSize.xs,
    color: '#94a3b8',
    marginTop: 3,
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },

  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.xs,
    marginTop: Spacing.md,
  },
  methodChip: {
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
  },
  methodText: { fontSize: FontSize.xs, color: Colors.textMuted, fontWeight: '500' },
  warnChip: {
    backgroundColor: 'rgba(217, 119, 6, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(217, 119, 6, 0.3)',
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
  },
  warnChipText: { fontSize: FontSize.xs, color: Colors.yellow, fontWeight: '600' },

  /* Shared card */
  card: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.xl,
    padding: Spacing.xl,
    marginTop: Spacing.md,
    ...Shadows.soft,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  cardTitle: { fontSize: FontSize.lg, fontWeight: '700', color: Colors.text },
  cardSub: { fontSize: FontSize.sm, color: Colors.textMuted },
  divider: { height: 1, backgroundColor: Colors.border, marginTop: Spacing.md },
  visualWrap: {
    alignItems: 'center',
    marginTop: Spacing.md,
  },

  clearBtn: { marginTop: Spacing.md, alignItems: 'center', paddingVertical: Spacing.sm },
  clearBtnText: { fontSize: FontSize.md, color: Colors.accent, fontWeight: '600' },

  trajLegend: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: Spacing.lg,
    marginTop: Spacing.md,
  },
  trajLegendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  trajDot: { width: 10, height: 10, borderRadius: 5 },
  trajLegendText: { fontSize: FontSize.xs, color: Colors.textMuted, fontWeight: '500' },

  /* 偵測詳情 */
  detailGrid: { marginTop: Spacing.md, gap: 6 },
  detailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 2,
  },
  detailLabel: { fontSize: FontSize.sm, color: Colors.textMuted },
  detailValue: { fontSize: FontSize.sm, color: Colors.text, fontWeight: '600', fontVariant: ['tabular-nums'] },

  /* Break & Spin */
  kineBlock: {
    marginTop: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: Colors.border,
  },
  kineHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  kineSectionTitle: {
    fontSize: FontSize.sm,
    fontWeight: '700',
    color: Colors.text,
    letterSpacing: 0.3,
  },
  kineConfPill: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.accent,
    backgroundColor: 'rgba(79,142,247,0.12)',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    overflow: 'hidden',
    fontVariant: ['tabular-nums'],
  },
  breakChartWrap: {
    alignItems: 'center',
    paddingVertical: Spacing.sm,
  },
  breakTotalHint: {
    textAlign: 'center',
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 4,
  },
  breakTotalVal: {
    fontSize: 14,
    fontWeight: '800',
    color: Colors.text,
    fontVariant: ['tabular-nums'],
  },
  /* Video */
  videoCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    marginTop: Spacing.md,
    ...Shadows.soft,
  },
  videoCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  videoTitleWrap: {
    flex: 1,
    gap: 2,
  },
  videoTabsWrap: {
    marginHorizontal: -Spacing.lg,
    marginBottom: Spacing.sm,
  },
  videoPlayer: {
    width: '100%',
    borderRadius: Radius.lg,
    backgroundColor: '#000',
  },
  videoHint: {
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: Spacing.sm,
    lineHeight: 16,
  },
  downloadBtn: {
    backgroundColor: Colors.accent,
    borderRadius: Radius.sm,
    paddingVertical: 5,
    paddingHorizontal: Spacing.md,
  },
  downloadBtnText: { fontSize: FontSize.sm, fontWeight: '700', color: '#fff' },

  /* Log viewer */
  logHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  logToggleText: {
    fontSize: FontSize.sm,
    color: Colors.accent,
    fontWeight: '600',
  },
  logBody: {
    backgroundColor: '#0d1117',
    borderRadius: 10,
    padding: 10,
    marginTop: Spacing.sm,
    maxHeight: 260,
  },
  logLine: {
    fontFamily: 'Courier',
    fontSize: 10.5,
    lineHeight: 18,
    color: '#c9d1d9',
  },
  logError: {
    color: '#ff6b6b',
  },

  /* CTA */
  ctaWrap: { paddingTop: Spacing.lg, paddingBottom: 8 },
  ctaBtn: {
    backgroundColor: Colors.accent,
    height: 50,
    borderRadius: Radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: Colors.accent,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 4,
  },
  ctaBtnText: { fontSize: FontSize.lg, fontWeight: '700', color: '#fff', letterSpacing: 0.3 },
});
