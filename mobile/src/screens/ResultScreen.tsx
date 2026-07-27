import React, { useCallback, useMemo, useRef, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Linking, Alert, useWindowDimensions } from 'react-native';
import * as Sharing from 'expo-sharing';
import { Colors, Spacing, Radius, FontSize, Layout, Shadows, Surfaces } from '../theme';
import VideoPlayer from '../components/VideoPlayer';
import { useResult } from '../context/ResultContext';
import { formatSpeed, pitchColor, pitchTypeLabel, shortMethod, speedUnitLabel } from '../utils/conversions';
import StrikeZone from '../components/StrikeZone';
import BreakChart from '../components/BreakChart';
import { friendlyError } from '../utils/errors';
import SegmentedTabs from '../components/SegmentedTabs';
import { useNavigation } from '@react-navigation/native';
import type { PitchResult } from '../types';
import { useSettings } from '../context/SettingsContext';

const VIDEO_TAB_OVERLAY = '分析疊圖';
const VIDEO_TAB_ORIGINAL = '原始錄影';
const RESULT_TAB_OVERVIEW = '總覽';
const RESULT_TAB_VIDEO = '影片';
const RESULT_TAB_DETAILS = '細節';
const RESULT_TABS = [RESULT_TAB_OVERVIEW, RESULT_TAB_VIDEO, RESULT_TAB_DETAILS];
const EMPTY_RESULT: PitchResult = { job_id: '', speed_info: {}, created_at: '' };

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function resolveUriHelper(url: string | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('file://') || url.startsWith('/')) return url;
  return null;
}

export default function ResultScreen() {
  const { width } = useWindowDimensions();
  const { result, sessionPitches, clearPitches, analysisLogs } = useResult();
  const { settings } = useSettings();
  const navigation = useNavigation<any>();
  const [showLogs, setShowLogs] = useState(false);
  const [videoTab, setVideoTab] = useState<string>(VIDEO_TAB_OVERLAY);
  const [resultTab, setResultTab] = useState<string>(RESULT_TAB_OVERVIEW);
  const [showQualityDetails, setShowQualityDetails] = useState(false);
  const logScrollRef = useRef<ScrollView>(null);
  const analysis = result ?? EMPTY_RESULT;

  const si = analysis.speed_info || {};
  const primaryKmh = si.release_speed_kmh ?? si.initial_speed_kmh ?? null;
  const speedUnit = settings.speedUnit;
  const speedUnitText = speedUnitLabel(speedUnit);
  const alternateUnit = speedUnit === 'mph' ? 'kmh' : 'mph';
  const primarySpeed = primaryKmh !== null ? formatSpeed(primaryKmh, speedUnit) : null;
  const alternateSpeed = primaryKmh !== null ? formatSpeed(primaryKmh, alternateUnit) : null;
  const maxKmh = si.max_speed_kmh ?? null;
  const flightS = si.flight_time_s ?? null;
  const breakH = si.horizontal_break_cm ?? null;
  const breakVObserved = si.vertical_break_cm ?? null;
  const breakVInduced = si.induced_vertical_break_cm ?? null;
  const breakTotal = si.total_break_cm ?? null;
  const breakConf = si.break_confidence ?? null;
  const breakGravity = si.break_gravity_drop_cm ?? null;
  const breakFitR2 = si.break_fit_r2 ?? null;
  const breakEndpointSource = si.break_endpoint_source ?? null;
  const breakSamples = si.break_samples ?? null;
  const breakActualRatio = si.break_actual_sample_ratio ?? null;
  const breakScaleX = si.break_cm_per_px_x ?? null;
  const breakScaleY = si.break_cm_per_px_y ?? null;
  const spinRpm = si.spin_rpm ?? null;
  const hasBreakChart = breakH !== null && breakVInduced !== null;
  const batterHeight = si.batter_height_m ?? null;
  const zoneWidthCm = si.strike_zone_width_cm ?? null;
  const zoneHeightCm = si.strike_zone_height_cm ?? null;

  const physClamped = si.physics_clamped ?? false;
  const pitchType = si.pitch_type && si.pitch_type !== 'Unknown' ? si.pitch_type : null;
  const pitchConf = si.pitch_confidence ? Math.round(si.pitch_confidence * 100) : null;
  const method = shortMethod(si.calculation_method);
  const hasWarn = !!si.trajectory_quality_warning;
  const panelWidth = Math.min(width - 32, Layout.maxWidth);
  const speedFontSize = width < 380 ? 66 : 82;

  // Stable identity so StrikeZone / VideoPlayer don't see new prop refs on
  // unrelated re-renders (e.g. log toggle, tab switch).
  const overlayUrl = useMemo(
    () => resolveUriHelper(analysis.overlay_uri || analysis.overlay_url),
    [analysis.overlay_uri, analysis.overlay_url],
  );
  const originalUrl = useMemo(
    () => resolveUriHelper(analysis.original_url),
    [analysis.original_url],
  );
  const hasOverlay = !!overlayUrl && !overlayUrl.includes('/dev/');
  const hasOriginal = !!originalUrl;
  const showOverlayTab = hasOverlay && videoTab === VIDEO_TAB_OVERLAY;
  const activeVideoUrl = showOverlayTab ? overlayUrl : (hasOriginal ? originalUrl : overlayUrl);
  const hasResultVideo = (hasOverlay || hasOriginal) && !!activeVideoUrl;
  const resultTabs = hasResultVideo ? RESULT_TABS : RESULT_TABS.filter((tab) => tab !== RESULT_TAB_VIDEO);
  const selectedResultTab = resultTabs.includes(resultTab) ? resultTab : RESULT_TAB_OVERVIEW;
  const videoAspectRatio = analysis.video_width && analysis.video_height
    ? analysis.video_width / analysis.video_height
    : 16 / 9;
  const detectionPct = analysis.total_frames && analysis.yolo_raw_detection_frames != null
    ? Math.round((analysis.yolo_raw_detection_frames / analysis.total_frames) * 100)
    : null;
  const trajectoryActual = analysis.trajectory_actual_count ?? null;
  const trajectorySynthetic = analysis.trajectory_synthetic_count ?? null;
  const trajectoryTotal = analysis.trajectory_count ?? null;
  const actualTrajectoryRatio = trajectoryTotal && trajectoryActual != null
    ? trajectoryActual / Math.max(1, trajectoryTotal)
    : breakActualRatio;
  const syntheticPct = trajectoryTotal && trajectorySynthetic != null
    ? Math.round((trajectorySynthetic / Math.max(1, trajectoryTotal)) * 100)
    : null;
  const sourceFps = analysis.source_fps ?? null;
  const captureFps = analysis.capture_fps ?? null;
  const effectiveCaptureFps = analysis.effective_capture_fps ?? analysis.fps ?? null;
  const interpolationFactor = analysis.interpolation_factor ?? null;
  const qualityParts = {
    detection: detectionPct !== null ? clamp01(detectionPct / 18) : 0.55,
    actual: actualTrajectoryRatio !== null && actualTrajectoryRatio !== undefined ? clamp01(actualTrajectoryRatio) : 0.65,
    plate: si.plate_fit_error_px != null ? clamp01(1 - si.plate_fit_error_px / 90) : (si.catch_point_confidence ?? 0.55),
    break: breakConf ?? 0.55,
    distance: si.distance_source === 'manual' ? 1 : si.distance_source === 'pose_estimated' ? 0.72 : 0.42,
    warning: hasWarn || physClamped ? 0.72 : 1,
  };
  const qualityScore = Math.round(clamp01(
    0.22 * qualityParts.detection
    + 0.22 * qualityParts.actual
    + 0.20 * qualityParts.plate
    + 0.16 * qualityParts.break
    + 0.12 * qualityParts.distance
    + 0.08 * qualityParts.warning,
  ) * 100);
  const qualityTone = qualityScore >= 78 ? 'good' : qualityScore >= 58 ? 'fair' : 'poor';
  const qualityLabel = qualityTone === 'good' ? '高可信' : qualityTone === 'fair' ? '需留意' : '建議重拍';
  const qualityRows = [
    { label: '偵測覆蓋', value: detectionPct !== null ? `${detectionPct}%` : '—' },
    { label: '實測軌跡', value: actualTrajectoryRatio != null ? `${Math.round(actualTrajectoryRatio * 100)}%` : '—' },
    { label: '落點信心', value: si.catch_point_confidence != null ? `${Math.round(si.catch_point_confidence * 100)}%` : '—' },
    { label: '位移信心', value: breakConf !== null ? `${Math.round(breakConf * 100)}%` : '—' },
  ];
  const qualitySuggestions = [
    detectionPct !== null && detectionPct < 6 ? '偵測覆蓋偏低，建議使用 120fps 或提高光線。' : null,
    actualTrajectoryRatio != null && actualTrajectoryRatio < 0.55 ? '軌跡補點比例偏高，數據較依賴模型推估。' : null,
    si.distance_source !== 'manual' ? '輸入實際投打距離可提升球速與位移可信度。' : null,
    hasWarn || physClamped ? '本次軌跡或速度有品質警告，請優先參考趨勢。' : null,
  ].filter(Boolean) as string[];
  const heroStats = [
    { label: `最高 · ${speedUnitText}`, value: maxKmh !== null ? formatSpeed(maxKmh, speedUnit) : '-' },
    { label: '飛行時間 · 秒', value: flightS !== null ? flightS.toFixed(3) : '-' },
    { label: '總位移 · cm', value: breakTotal !== null ? breakTotal.toFixed(1) : '-' },
    { label: '轉速 · rpm', value: spinRpm !== null ? Math.round(spinRpm).toLocaleString() : '-' },
  ];
  const movementRows = [
    { label: '水平位移', value: breakH, unit: 'cm', tone: 'default' },
    { label: '原始垂直', value: breakVObserved, unit: 'cm', tone: 'default' },
    { label: '重力下墜', value: breakGravity, unit: 'cm', tone: 'muted' },
    { label: '垂直位移', value: breakVInduced, unit: 'cm', tone: (breakVInduced ?? 0) >= 0 ? 'green' : 'red' },
  ];
  const movementQualityRows = [
    { label: '方向擬合 R²', value: breakFitR2 !== null ? breakFitR2.toFixed(2) : '—' },
    { label: '軌跡樣本', value: breakSamples !== null ? `${breakSamples}` : '—' },
    { label: '實測樣本比例', value: breakActualRatio !== null ? `${Math.round(breakActualRatio * 100)}%` : '—' },
    { label: '落點來源', value: breakEndpointSource ?? '—' },
    {
      label: '比例尺',
      value: breakScaleX !== null && breakScaleY !== null
        ? `${breakScaleX.toFixed(2)} / ${breakScaleY.toFixed(2)} cm/px`
        : '—',
    },
  ];

  const plateZone = si.plate_zone ?? null;
  const zoneOverride = useMemo(
    () => plateZone
      ? { xMin: plateZone.x_min, xMax: plateZone.x_max, yMin: plateZone.y_min, yMax: plateZone.y_max }
      : null,
    [plateZone?.x_min, plateZone?.x_max, plateZone?.y_min, plateZone?.y_max],
  );

  const handleOpenTrajectory = useCallback(() => {
    if (!result) return;
    navigation.navigate('TrajectorySimulation', {
      pitch: result,
      title: '本球 3D 軌跡',
    });
  }, [navigation, result]);

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

  if (!result) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyTitle}>尚無分析結果</Text>
        <Text style={styles.emptySubtitle}>
          前往 <Text style={{ fontWeight: '700', color: Colors.accent }}>分析</Text> 頁面選擇影片開始分析。
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>

      {/* ── Hero Card ─────────────────────────────────────── */}
      <View style={[styles.heroCard, { width: panelWidth }]}>
        <Text style={styles.heroEyebrow}>本球結果</Text>
        {/* Pitch type badge row */}
        <View style={styles.badgeRow}>
          <View style={styles.badgeGroup}>
          {pitchType && (
            <View style={[styles.typeBadge, { backgroundColor: pitchColor(pitchType) }]}>
              <Text style={styles.typeBadgeText}>{pitchTypeLabel(pitchType)}</Text>
            </View>
          )}
          <View style={[
            styles.callBadge,
            si.is_strike === true && styles.callBadgeStrike,
            si.is_strike === false && styles.callBadgeBall,
          ]}>
            <Text style={[
              styles.callBadgeText,
              si.is_strike === true && { color: Colors.green },
              si.is_strike === false && { color: Colors.red },
            ]}>
              {si.is_strike === true ? '好球' : si.is_strike === false ? '壞球' : '未判定'}
            </Text>
          </View>
          </View>
          {pitchConf !== null && <Text style={styles.confText}>球種信心 {pitchConf}%</Text>}
        </View>

        {/* Big speed number */}
        <View
          style={styles.speedWrap}
          accessible
          accessibilityLabel={
            primarySpeed !== null
              ? `球速 ${primarySpeed} ${speedUnitText}`
              : '無法計算球速'
          }
        >
          {primarySpeed !== null ? (
            <>
              <Text style={[styles.speedNum, { fontSize: speedFontSize, lineHeight: speedFontSize }]}>{primarySpeed}</Text>
              <View style={styles.speedMeta}>
                <Text style={styles.speedUnit}>{speedUnitText}</Text>
                <Text style={styles.speedKmh}>{alternateSpeed} {speedUnitLabel(alternateUnit)}</Text>
              </View>
            </>
          ) : (
            <Text style={styles.speedNA}>無法計算球速</Text>
          )}
        </View>

        {/* Divider */}
        <View style={styles.heroDivider} />

        {/* Stats grid */}
        <View style={styles.statsGrid}>
          {heroStats.map((stat) => (
            <View key={stat.label} style={styles.statItem}>
              <Text style={styles.statVal} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.78}>
                {stat.value}
              </Text>
              <Text style={styles.statLbl} numberOfLines={1}>{stat.label}</Text>
            </View>
          ))}
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
        <View style={[
          styles.resultInsight,
          qualityTone === 'good' ? styles.resultInsightGood : qualityTone === 'fair' ? styles.resultInsightFair : styles.resultInsightPoor,
        ]}>
          <View style={styles.resultInsightCopy}>
            <Text style={styles.resultInsightTitle}>
              {si.is_strike === true ? '落點進入好球帶' : si.is_strike === false ? '落點在好球帶外' : '本球落點尚未判定'}
            </Text>
            <Text style={styles.resultInsightText}>分析品質 {qualityScore}% · {qualityLabel}</Text>
          </View>
          <View style={styles.resultInsightScore}>
            <Text style={styles.resultInsightScoreText}>{qualityScore}</Text>
          </View>
        </View>
        <TouchableOpacity
          style={styles.trajectoryHeroBtn}
          onPress={handleOpenTrajectory}
          accessibilityRole="button"
          accessibilityLabel="查看本球 3D 軌跡模擬"
          activeOpacity={0.78}
        >
          <Text style={styles.trajectoryHeroBtnText}>查看 3D 軌跡模擬</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.resultTabsWrap, { width: panelWidth }]}>
        <SegmentedTabs
          tabs={resultTabs}
          activeTab={selectedResultTab}
          onSelect={setResultTab}
          containerStyle={styles.resultTabs}
        />
      </View>

      {selectedResultTab === RESULT_TAB_OVERVIEW && (
        <>
      {/* ── Analysis Quality ──────────────────────────────── */}
      <View style={[styles.card, { width: panelWidth }]}>
        <View style={styles.qualityHeader}>
          <View>
            <Text style={styles.cardTitle}>分析品質</Text>
            <Text style={styles.cardSub}>偵測與軌跡可信度</Text>
          </View>
          <View style={[
            styles.qualityScorePill,
            qualityTone === 'good' && styles.qualityGood,
            qualityTone === 'fair' && styles.qualityFair,
            qualityTone === 'poor' && styles.qualityPoor,
          ]}>
            <Text style={styles.qualityScoreText}>{qualityScore}</Text>
            <Text style={styles.qualityScoreUnit}>%</Text>
          </View>
        </View>
        <View style={styles.qualityBarTrack}>
          <View style={[
            styles.qualityBarFill,
            { width: `${qualityScore}%` },
            qualityTone === 'good' && styles.qualityBarGood,
            qualityTone === 'fair' && styles.qualityBarFair,
            qualityTone === 'poor' && styles.qualityBarPoor,
          ]} />
        </View>
        <View style={styles.qualitySummaryRow}>
          <Text style={[
            styles.qualityLabel,
            qualityTone === 'good' && { color: Colors.green },
            qualityTone === 'fair' && { color: Colors.yellow },
            qualityTone === 'poor' && { color: Colors.red },
          ]}>
            {qualityLabel}
          </Text>
          <Text style={styles.qualityMeta}>
            {effectiveCaptureFps ? `分析 ${effectiveCaptureFps}fps` : 'FPS —'}
            {interpolationFactor && interpolationFactor > 1 ? ` / ${interpolationFactor}x 補幀` : ''}
          </Text>
        </View>
        <TouchableOpacity
          style={styles.qualityToggle}
          onPress={() => setShowQualityDetails((value) => !value)}
          accessibilityRole="button"
          accessibilityState={{ expanded: showQualityDetails }}
        >
          <Text style={styles.qualityToggleText}>{showQualityDetails ? '收起品質細節' : '查看品質細節'}</Text>
          <Text style={styles.qualityToggleIcon}>{showQualityDetails ? '▲' : '▼'}</Text>
        </TouchableOpacity>
        {showQualityDetails && (
          <>
            <View style={styles.qualityGrid}>
              {qualityRows.map((row) => (
                <View key={row.label} style={styles.qualityTile}>
                  <Text style={styles.qualityTileValue}>{row.value}</Text>
                  <Text style={styles.qualityTileLabel}>{row.label}</Text>
                </View>
              ))}
            </View>
            {qualitySuggestions.length > 0 && (
              <View style={styles.qualityNotePanel}>
                {qualitySuggestions.slice(0, 3).map((tip) => (
                  <Text key={tip} style={styles.qualityNote}>• {tip}</Text>
                ))}
              </View>
            )}
          </>
        )}
      </View>


      {/* ── Strike Zone ───────────────────────────────────── */}
      <View style={[styles.card, { width: panelWidth }]}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>好球帶落點</Text>
          <Text style={styles.cardSub}>
            {batterHeight !== null ? `打者 ${batterHeight.toFixed(2)} m` : `本次練習 ${sessionPitches.length} 球`}
          </Text>
        </View>
        <View style={styles.divider} />
        <View style={styles.visualWrap}>
          <StrikeZone pitches={sessionPitches} zoneOverride={zoneOverride} />
        </View>
        {zoneWidthCm !== null && zoneHeightCm !== null && (
          <Text style={styles.zoneRuleText}>
            MLB ABS：寬 {zoneWidthCm.toFixed(1)} cm，高 {zoneHeightCm.toFixed(1)} cm
          </Text>
        )}
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
            <Text style={styles.cardSub}>水平與垂直位移</Text>
          </View>
          <View style={styles.divider} />

          {/* Break block — MLB-style X/Y chart */}
          {hasBreakChart && (
            <View style={styles.kineBlock}>
              <View style={styles.kineHeaderRow}>
                <Text style={styles.kineSectionTitle}>位移分析</Text>
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
              <View style={styles.movementGrid}>
                {movementRows.map((row) => (
                  <View key={row.label} style={styles.movementTile}>
                    <Text
                      style={[
                        styles.movementValue,
                        row.tone === 'green' && styles.movementPositive,
                        row.tone === 'red' && styles.movementNegative,
                        row.tone === 'muted' && styles.movementMuted,
                      ]}
                    >
                      {row.value !== null ? `${row.value >= 0 ? '+' : ''}${row.value.toFixed(1)}` : '—'}
                    </Text>
                    <Text style={styles.movementUnit}>{row.unit}</Text>
                    <Text style={styles.movementLabel}>{row.label}</Text>
                  </View>
                ))}
              </View>
              <View style={styles.movementQualityPanel}>
                {movementQualityRows.map((row) => (
                  <View key={row.label} style={styles.movementQualityRow}>
                    <Text style={styles.movementQualityLabel}>{row.label}</Text>
                    <Text style={styles.movementQualityValue} numberOfLines={1}>{row.value}</Text>
                  </View>
                ))}
              </View>
            </View>
          )}

        </View>
      )}
        </>
      )}

      {/* ── Video Player ──────────────────────────────────── */}
      {selectedResultTab === RESULT_TAB_VIDEO && hasResultVideo && activeVideoUrl && (
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

      {selectedResultTab === RESULT_TAB_DETAILS && (
        <>
      {/* ── 分析詳情（給使用者的精簡版；__DEV__ 顯示完整內部數值） ── */}
      {analysis.yolo_ball_in_frame_count !== undefined && (
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
                {analysis.video_width && analysis.video_height
                  ? `${analysis.video_width} × ${analysis.video_height}`
                  : '—'}
              </Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>幀率（FPS）</Text>
              <Text style={styles.detailValue}>
                {sourceFps ? `${sourceFps} → ${analysis.fps ?? '—'}` : analysis.fps ?? '—'}
              </Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>補幀設定</Text>
              <Text style={styles.detailValue}>
                {interpolationFactor ? `${interpolationFactor}x / capture ${captureFps ?? '—'} → ${effectiveCaptureFps ?? '—'}` : '—'}
              </Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>偵測到球的幀數</Text>
              <Text style={[styles.detailValue, { color: (analysis.yolo_raw_detection_frames ?? 0) > 0 ? Colors.green : Colors.red }]}>
                {analysis.yolo_raw_detection_frames ?? '—'}
                {analysis.total_frames ? ` / ${analysis.total_frames}` : ''}
              </Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>偵測覆蓋率</Text>
              <Text style={styles.detailValue}>{detectionPct !== null ? `${detectionPct}%` : '—'}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>軌跡點數</Text>
              <Text style={styles.detailValue}>
                {trajectoryTotal ?? '—'}
                {syntheticPct !== null ? `（補點 ${syntheticPct}%）` : ''}
              </Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>落點來源 / 誤差</Text>
              <Text style={styles.detailValue}>
                {si.catch_point_source ?? '—'}
                {si.plate_fit_error_px != null ? ` / ${si.plate_fit_error_px.toFixed(1)}px` : ''}
              </Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>距離來源</Text>
              <Text style={styles.detailValue}>{si.distance_source ?? '—'}</Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>好球帶規則</Text>
              <Text style={styles.detailValue}>
                {batterHeight !== null && zoneHeightCm !== null ? `ABS ${batterHeight.toFixed(2)}m / ${zoneHeightCm.toFixed(1)}cm` : '—'}
              </Text>
            </View>
            <View style={styles.detailRow}>
              <Text style={styles.detailLabel}>出手到接球幀</Text>
              <Text style={styles.detailValue}>
                {si.release_frame_idx != null && si.catch_frame_idx != null
                  ? `${si.release_frame_idx} -> ${si.catch_frame_idx}`
                  : '—'}
              </Text>
            </View>

            {/* Internal frame-index data — dev only */}
            {__DEV__ && (
              <>
                <View style={styles.divider} />
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>YOLO 處理幀（dev）</Text>
                  <Text style={styles.detailValue}>{analysis.yolo_frames_processed ?? '—'}</Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>YOLO 偵測總次數（dev）</Text>
                  <Text style={styles.detailValue}>{analysis.yolo_total_detections ?? '—'}</Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>球在幀中 Phase1（dev）</Text>
                  <Text style={[styles.detailValue, { color: analysis.yolo_ball_in_frame_count! > 0 ? Colors.green : Colors.red }]}>
                    {analysis.yolo_ball_in_frame_count ?? '—'}
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
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>時間來源（dev）</Text>
                  <Text style={styles.detailValue}>{si.flight_time_source ?? '—'}</Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>TTC 狀態（dev）</Text>
                  <Text style={styles.detailValue}>{si.ttc_status ?? '—'}</Text>
                </View>
                <View style={styles.detailRow}>
                  <Text style={styles.detailLabel}>TTC / 影像秒數（dev）</Text>
                  <Text style={styles.detailValue}>
                    {si.ttc_flight_time_s != null || si.visual_flight_time_s != null
                      ? `${si.ttc_flight_time_s?.toFixed(3) ?? '—'} / ${si.visual_flight_time_s?.toFixed(3) ?? '—'}`
                      : '—'}
                  </Text>
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
        </>
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
  heroEyebrow: {
    color: '#7dd3fc',
    fontSize: FontSize.xs,
    fontWeight: '900',
    letterSpacing: 0.8,
    marginBottom: Spacing.sm,
  },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
    marginBottom: Spacing.md,
  },
  badgeGroup: { flexDirection: 'row', alignItems: 'center', gap: Spacing.xs, flex: 1 },
  typeBadge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 99,
  },
  typeBadgeText: { fontSize: FontSize.sm, fontWeight: '700', color: Colors.onAccent },
  callBadge: {
    borderRadius: 99,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: '#475569',
  },
  callBadgeStrike: { borderColor: '#34d399', backgroundColor: 'rgba(16,185,129,0.12)' },
  callBadgeBall: { borderColor: '#f87171', backgroundColor: 'rgba(239,68,68,0.12)' },
  callBadgeText: { color: '#cbd5e1', fontSize: FontSize.sm, fontWeight: '800' },
  confText: { fontSize: FontSize.sm, color: '#cbd5e1', fontWeight: '700' },

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
  resultTabsWrap: {
    marginTop: Spacing.md,
  },
  resultTabs: {
    marginHorizontal: 0,
    marginVertical: 0,
  },

  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
  },
  statItem: {
    flexBasis: '47%',
    flexGrow: 1,
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: Radius.lg,
    paddingVertical: Spacing.sm,
    paddingHorizontal: 4,
    minWidth: 88,
  },
  statVal: { fontSize: FontSize.lg, fontWeight: '800', color: Colors.textInverse, fontVariant: ['tabular-nums'] },
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
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
  },
  methodText: { fontSize: FontSize.xs, color: '#cbd5e1', fontWeight: '700' },
  warnChip: {
    backgroundColor: 'rgba(217, 119, 6, 0.1)',
    borderWidth: 1,
    borderColor: 'rgba(217, 119, 6, 0.3)',
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
  },
  warnChipText: { fontSize: FontSize.xs, color: Colors.yellow, fontWeight: '600' },
  resultInsight: {
    marginTop: Spacing.md,
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderRadius: Radius.lg,
    borderWidth: 1,
    padding: Spacing.md,
  },
  resultInsightGood: { backgroundColor: 'rgba(16,185,129,0.10)', borderColor: 'rgba(52,211,153,0.28)' },
  resultInsightFair: { backgroundColor: 'rgba(245,158,11,0.10)', borderColor: 'rgba(251,191,36,0.30)' },
  resultInsightPoor: { backgroundColor: 'rgba(239,68,68,0.10)', borderColor: 'rgba(248,113,113,0.30)' },
  resultInsightCopy: { flex: 1 },
  resultInsightTitle: { color: Colors.textInverse, fontSize: FontSize.md, fontWeight: '900' },
  resultInsightText: { color: '#cbd5e1', fontSize: FontSize.sm, marginTop: 3 },
  resultInsightScore: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  resultInsightScoreText: { color: Colors.textInverse, fontSize: FontSize.lg, fontWeight: '900' },
  trajectoryHeroBtn: {
    marginTop: Spacing.md,
    minHeight: 46,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.accent,
  },
  trajectoryHeroBtnText: {
    color: '#fff',
    fontSize: FontSize.md,
    fontWeight: '900',
  },

  /* Quality */
  qualityHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
  },
  qualityScorePill: {
    minWidth: 74,
    height: 54,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    borderWidth: 1,
  },
  qualityGood: {
    backgroundColor: 'rgba(16,185,129,0.10)',
    borderColor: 'rgba(16,185,129,0.28)',
  },
  qualityFair: {
    backgroundColor: 'rgba(217,119,6,0.10)',
    borderColor: 'rgba(217,119,6,0.30)',
  },
  qualityPoor: {
    backgroundColor: 'rgba(239,68,68,0.10)',
    borderColor: 'rgba(239,68,68,0.30)',
  },
  qualityScoreText: {
    color: Colors.text,
    fontSize: 24,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  qualityScoreUnit: {
    color: Colors.textMuted,
    fontSize: 12,
    fontWeight: '900',
    marginLeft: 2,
    marginTop: 7,
  },
  qualityBarTrack: {
    height: 8,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    marginTop: Spacing.md,
  },
  qualityBarFill: {
    height: '100%',
    borderRadius: 999,
  },
  qualityBarGood: { backgroundColor: Colors.green },
  qualityBarFair: { backgroundColor: Colors.yellow },
  qualityBarPoor: { backgroundColor: Colors.red },
  qualitySummaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.md,
    marginTop: Spacing.sm,
  },
  qualityLabel: {
    fontSize: 13,
    fontWeight: '900',
  },
  qualityMeta: {
    flex: 1,
    textAlign: 'right',
    color: Colors.textMuted,
    fontSize: 12,
    fontWeight: '700',
  },
  qualityToggle: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
    borderRadius: Radius.lg,
  },
  qualityToggleText: { color: Colors.accent, fontSize: FontSize.sm, fontWeight: '800' },
  qualityToggleIcon: { color: Colors.accent, fontSize: FontSize.xs },
  qualityGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  qualityTile: {
    flexBasis: '47%',
    flexGrow: 1,
    minHeight: 60,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface2,
    padding: Spacing.md,
  },
  qualityTileValue: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  qualityTileLabel: {
    color: Colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    marginTop: 4,
  },
  qualityNotePanel: {
    marginTop: Spacing.md,
    borderRadius: Radius.lg,
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    gap: 5,
  },
  qualityNote: {
    color: Colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '600',
  },

  /* Shared card */
  card: {
    ...Surfaces.card,
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
  zoneRuleText: {
    marginTop: 8,
    textAlign: 'center',
    color: Colors.textMuted,
    fontSize: FontSize.xs,
    fontWeight: '700',
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
  movementGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  movementTile: {
    flexBasis: '47%',
    flexGrow: 1,
    minHeight: 82,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
  },
  movementValue: {
    fontSize: 24,
    lineHeight: 26,
    fontWeight: '900',
    color: Colors.text,
    fontVariant: ['tabular-nums'],
  },
  movementPositive: {
    color: Colors.green,
  },
  movementNegative: {
    color: Colors.red,
  },
  movementMuted: {
    color: Colors.textMuted,
  },
  movementUnit: {
    fontSize: 11,
    color: Colors.textMuted,
    fontWeight: '800',
    marginTop: 2,
  },
  movementLabel: {
    fontSize: 12,
    color: Colors.textMuted,
    fontWeight: '700',
    marginTop: 6,
  },
  movementQualityPanel: {
    marginTop: Spacing.md,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: '#f8fafc',
    padding: Spacing.md,
    gap: 7,
  },
  movementQualityRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.md,
  },
  movementQualityLabel: {
    fontSize: 12,
    color: Colors.textMuted,
    fontWeight: '700',
  },
  movementQualityValue: {
    flex: 1,
    textAlign: 'right',
    fontSize: 12,
    color: Colors.text,
    fontWeight: '800',
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
