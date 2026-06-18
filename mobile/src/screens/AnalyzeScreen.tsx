import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet,
  Alert, Linking, useWindowDimensions,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useNavigation } from '@react-navigation/native';
import { Colors, Layout, Radius, Shadows, Spacing } from '../theme';
import VideoPlayer from '../components/VideoPlayer';
import { useSettings } from '../context/SettingsContext';
import { useResult } from '../context/ResultContext';
import { analyzeVideo, checkFileSize, checkHealth } from '../api';
import { parseLog } from '../utils/pipelineStages';
import { useOfflineAnalysis } from '../hooks/useOfflineAnalysis';
import AnalysisProgress from '../components/AnalysisProgress';
import { friendlyError, isCancellation } from '../utils/errors';
import type { StrikeZoneCalibration } from '../types';

const MAX_MB = 50;
const ABS_ZONE_TOP_RATIO = 0.535;
const ABS_ZONE_BOTTOM_RATIO = 0.27;
const LEGACY_ZONE_HEIGHT_M = 0.58;

function applyAbsHeightToManualZone(
  zone: StrikeZoneCalibration | null | undefined,
  batterHeightM: number,
): StrikeZoneCalibration | null {
  if (!zone) return null;
  const currentHeight = zone.yMax - zone.yMin;
  if (currentHeight <= 0) return zone;

  const absHeightM = batterHeightM * (ABS_ZONE_TOP_RATIO - ABS_ZONE_BOTTOM_RATIO);
  const adjustedHeight = Math.max(0.08, Math.min(0.45, currentHeight * (absHeightM / LEGACY_ZONE_HEIGHT_M)));
  const cy = (zone.yMin + zone.yMax) / 2;
  const halfH = adjustedHeight / 2;
  const yMin = Math.max(0, Math.min(1 - adjustedHeight, cy - halfH));
  return {
    xMin: zone.xMin,
    xMax: zone.xMax,
    yMin,
    yMax: yMin + adjustedHeight,
  };
}

export default function AnalyzeScreen() {
  const { width } = useWindowDimensions();
  const { settings } = useSettings();
  const { setResult, addPitch, setAnalysisLogs } = useResult();
  const { analyze: analyzeOffline } = useOfflineAnalysis();
  const navigation = useNavigation<any>();

  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string>('video.mp4');
  const [videoMeta, setVideoMeta] = useState<{ sizeMB: string; durationS: string } | null>(null);
  const [batterHeightText, setBatterHeightText] = useState('');
  const [heightTouched, setHeightTouched] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const [stageMessages, setStageMessages] = useState<string[]>([]);
  const [rawLogs, setRawLogs] = useState<{ msg: string; isError: boolean }[]>([]);
  const rawLogsRef = useRef<{ msg: string; isError: boolean }[]>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [statusType, setStatusType] = useState<'' | 'error' | 'success'>('');
  const abortRef = useRef<AbortController | null>(null);

  const cancelAnalysis = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const batterHeightM = Number.parseFloat(batterHeightText);
  const hasValidBatterHeight = Number.isFinite(batterHeightM) && batterHeightM >= 1.0 && batterHeightM <= 2.4;
  const batterHeightError = heightTouched && batterHeightText.trim() !== '' && !hasValidBatterHeight;
  const effectiveStrikeZone = hasValidBatterHeight
    ? applyAbsHeightToManualZone(settings.strikeZone, batterHeightM)
    : settings.strikeZone;

  const resetAnalysis = () => {
    setUploadPct(0);
    setCurrentStage(null);
    setStageMessages([]);
    rawLogsRef.current = [];
    setRawLogs([]);
    setShowRaw(false);
  };

  const pickVideo = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      setStatusMsg('需要相簿存取權限才能選擇影片。');
      setStatusType('error');
      Alert.alert(
        '權限未開啟',
        '請到「設定 → SpeedGun → 照片」開啟相簿存取權。',
        [
          { text: '取消', style: 'cancel' },
          { text: '開啟設定', onPress: () => Linking.openSettings() },
        ],
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      quality: 1,
    });

    if (result.canceled || !result.assets?.[0]) return;

    const asset = result.assets[0];
    try {
      if (asset.fileSize) checkFileSize(asset.fileSize, MAX_MB);
    } catch (e: any) {
      setStatusMsg(e.message);
      setStatusType('error');
      return;
    }

    setVideoUri(asset.uri);
    setVideoName(asset.fileName || 'video.mp4');
    resetAnalysis();
    const sizeMB = asset.fileSize ? (asset.fileSize / 1024 / 1024).toFixed(1) : '?';
    const durationS = asset.duration != null ? (asset.duration / 1000).toFixed(1) : '?';
    setVideoMeta({ sizeMB, durationS });
    setStatusMsg(`✓ ${asset.fileName || 'Video selected'}`);
    setStatusType('success');
  }, []);

  const onAnalyzeOffline = async () => {
    if (!videoUri || analyzing || !hasValidBatterHeight) return;
    setAnalyzing(true);
    resetAnalysis();
    const initEntry = { msg: '[DEBUG] mode=offline', isError: false };
    rawLogsRef.current = [...rawLogsRef.current.slice(-200), initEntry];
    setRawLogs(rawLogsRef.current);
    setUploadPct(100); // No upload needed for offline
    setCurrentStage('init');
    setStatusMsg('');
    setStatusType('');

    try {
      const result = await analyzeOffline(
        videoUri,
        {
          moundDistanceM: settings.moundDistanceM,
          strideCorrectionM: settings.strideCorrectionM,
          confThreshold: settings.confThreshold,
          pitcherHeightM: settings.pitcherHeightM,
          batterHeightM,
          strikeZone: effectiveStrikeZone,
        },
        {
          onStage: (stageId) => {
            setCurrentStage(stageId);
          },
          onMessage: (msg) => {
            setStageMessages((prev) => {
              const last = prev[prev.length - 1];
              if (last === msg) return prev;
              return [...prev.slice(-20), msg];
            });
            const newEntry = { msg, isError: false };
            rawLogsRef.current = [...rawLogsRef.current.slice(-200), newEntry];
            setRawLogs(rawLogsRef.current);
          },
          onProgress: (pct) => {
            setUploadPct(pct);
          },
        },
      );

      setCurrentStage('done');
      setStatusMsg('分析完成！');
      setStatusType('success');
      setAnalysisLogs(rawLogsRef.current);
      setResult(result);
      addPitch(result);
      navigation.navigate('Result');
    } catch (err: any) {
      if (isCancellation(err)) {
        setStatusMsg('已取消分析。');
        setStatusType('');
      } else {
        setStatusMsg(friendlyError(err, { action: '離線分析' }) ?? '離線分析失敗。');
        setStatusType('error');
      }
    } finally {
      setAnalyzing(false);
    }
  };

  const onAnalyzeOnline = async () => {
    if (!videoUri || analyzing || !hasValidBatterHeight) return;
    setAnalyzing(true);
    resetAnalysis();
    const initEntry2 = { msg: '[DEBUG] mode=online', isError: false };
    rawLogsRef.current = [...rawLogsRef.current.slice(-200), initEntry2];
    setRawLogs(rawLogsRef.current);
    setStatusMsg('');
    setStatusType('');

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await analyzeVideo(
        settings.backendUrl,
        videoUri,
        videoName,
        {
          moundDistanceM: settings.moundDistanceM,
          strideCorrectionM: settings.strideCorrectionM,
          confThreshold: settings.confThreshold,
          batterHeightM,
          strikeZone: effectiveStrikeZone,
          signal: controller.signal,
        },
        (pct) => {
          setUploadPct(pct);
          if (pct >= 100) setCurrentStage('init');
        },
        (entry) => {
          if (entry.level === 'DONE') return;

          const raw = entry.message || '';
          const parsed = parseLog(raw);
          if (parsed) {
            if (parsed.stageId) {
              setCurrentStage(parsed.stageId);
            }
            if (!parsed.isError) {
              setStageMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last === parsed.userMsg) return prev;
                return [...prev.slice(-20), parsed.userMsg];
              });
            }
          }

          if (raw && !/NORM_RECT|XNNPACK|inference_feedback|gl_context/.test(raw)) {
            const cleanMsg = raw.replace(/^[\w.]+\s*[–-]\s*/, '').trim();
            const newEntry2 = { msg: cleanMsg, isError: entry.level === 'ERROR' };
            rawLogsRef.current = [...rawLogsRef.current.slice(-200), newEntry2];
            setRawLogs(rawLogsRef.current);
          }
        },
      );

      setCurrentStage('done');
      setStatusMsg('分析完成！');
      setStatusType('success');
      setAnalysisLogs(rawLogsRef.current);
      setResult(result);
      addPitch(result);
      navigation.navigate('Result');
    } catch (err: any) {
      if (isCancellation(err)) {
        setStatusMsg('已取消分析。');
        setStatusType('');
      } else {
        setStatusMsg(friendlyError(err, { action: '分析' }) ?? '分析失敗。');
        setStatusType('error');
      }
    } finally {
      abortRef.current = null;
      setAnalyzing(false);
    }
  };

  const onAnalyze = async () => {
    setHeightTouched(true);
    if (!hasValidBatterHeight) {
      setStatusMsg('請先輸入打者身高（公尺），系統會依 MLB ABS 規則計算好球帶。');
      setStatusType('error');
      return;
    }

    if (settings.analysisMode === 'offline') {
      await onAnalyzeOffline();
      return;
    }

    // For simulator/dev setups, backend may be unavailable; fall back to offline
    // so users can still get overlay output instead of a stalled online flow.
    const healthy = await checkHealth(settings.backendUrl);
    if (!healthy) {
      setRawLogs((prev) => [...prev.slice(-200), { msg: `ℹ️ 後端無法連線，自動改用裝置端離線分析`, isError: false }]);
      await onAnalyzeOffline();
      return;
    }

    await onAnalyzeOnline();
  };
  const isOffline = settings.analysisMode === 'offline';
  const panelWidth = Math.min(width - 32, Layout.maxWidth);
  const canAnalyze = !!videoUri && !analyzing && hasValidBatterHeight;

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
      {analyzing ? (
        <View style={[styles.responsivePane, { width: panelWidth, marginTop: 16 }]}>
          <AnalysisProgress
            uploadPct={uploadPct}
            stageId={currentStage}
            stageMessages={stageMessages}
            rawLogs={rawLogs}
            showRaw={showRaw}
          />
          <TouchableOpacity
            style={styles.rawToggle}
            onPress={() => setShowRaw((v) => !v)}
            hitSlop={{ top: 10, bottom: 10, left: 16, right: 16 }}
            accessibilityRole="button"
            accessibilityLabel={showRaw ? '隱藏技術詳情' : '查看技術詳情'}
          >
            <Text style={styles.rawToggleText}>
              {showRaw ? '▲ 隱藏技術詳情' : '▼ 查看技術詳情'}
            </Text>
          </TouchableOpacity>
          {!isOffline && (
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={cancelAnalysis}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel="取消目前的上傳與分析"
            >
              <Text style={styles.cancelBtnText}>取消上傳 / 分析</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        <View style={[styles.responsivePane, { width: panelWidth }]}>
          <View
            style={styles.heroPanel}
            accessible
            accessibilityLabel={`投球分析。模式：${isOffline ? '裝置端離線分析' : '伺服器分析'}。距離 ${settings.moundDistanceM > 0 ? settings.moundDistanceM.toFixed(1) + ' 公尺' : '自動估算'}。`}
          >
            <View style={styles.heroTopRow}>
              <View>
                <Text style={styles.eyebrow}>PITCH LAB</Text>
                <Text style={styles.heroTitle}>投球分析</Text>
              </View>
              <View style={styles.liveBadge}>
                <View style={[styles.modeDot, { backgroundColor: isOffline ? Colors.green : Colors.accent }]} />
                <Text style={styles.liveBadgeText}>{isOffline ? '離線' : '雲端'}</Text>
              </View>
            </View>
            <Text style={styles.heroCopy}>
              上傳慢動作影片，系統會偵測球路軌跡、出手速度、落點與位移資料。
            </Text>
            <View style={styles.heroMetricRow}>
              <View style={styles.heroMetric}>
                <Text style={styles.heroMetricValue}>{hasValidBatterHeight ? batterHeightM.toFixed(2) : '-'}</Text>
                <Text style={styles.heroMetricLabel}>打者身高 m</Text>
              </View>
              <View style={styles.heroMetric}>
                <Text style={styles.heroMetricValue}>{settings.moundDistanceM > 0 ? settings.moundDistanceM.toFixed(1) : 'AUTO'}</Text>
                <Text style={styles.heroMetricLabel}>距離 m</Text>
              </View>
              <View style={styles.heroMetric}>
                <Text style={styles.heroMetricValue}>{settings.confThreshold.toFixed(2)}</Text>
                <Text style={styles.heroMetricLabel}>信心閾值</Text>
              </View>
            </View>
          </View>

          {/* Mode badge */}
          <View style={styles.modeBadge}>
            <View style={[styles.modeDot, { backgroundColor: isOffline ? '#10b981' : '#3b82f6' }]} />
            <Text style={styles.modeText}>
              {isOffline ? '離線模式 — 裝置端運算' : '線上模式 — 伺服器運算'}
            </Text>
          </View>

          {/* Video picker */}
          <TouchableOpacity
            style={styles.dropZone}
            onPress={pickVideo}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={videoUri ? '更換投球影片' : '從相簿選擇投球影片'}
            accessibilityHint={`最大 ${MAX_MB} MB`}
          >
            <Text style={styles.dropTitle}>
              {videoUri ? '已選擇影片' : '選擇投球影片'}
            </Text>
            <Text style={styles.dropSubtitle}>
              {videoUri ? '點擊更換影片' : `點擊從相簿選取\n上限 ${MAX_MB} MB`}
            </Text>
          </TouchableOpacity>

          {/* Batter height */}
          <View style={styles.heightCard}>
            <View style={styles.heightHeader}>
              <Text style={styles.heightTitle}>打者身高</Text>
              <Text style={styles.heightBadge}>MLB ABS</Text>
            </View>
            <TextInput
              style={[styles.heightInput, batterHeightError && styles.inputError]}
              value={batterHeightText}
              onChangeText={(v) => {
                setBatterHeightText(v);
                if (statusType === 'error') {
                  setStatusMsg('');
                  setStatusType('');
                }
              }}
              onBlur={() => setHeightTouched(true)}
              keyboardType="decimal-pad"
              placeholder="例如 1.78"
              placeholderTextColor={Colors.textMuted}
              returnKeyType="done"
              accessibilityLabel="打者身高，公尺，開始分析前必填"
            />
            <Text style={[styles.heightHint, batterHeightError && { color: Colors.red }]}>
              {batterHeightError
                ? '請輸入 1.00 到 2.40 公尺之間的身高'
                : '系統會以 17 吋寬、27% 到 53.5% 身高的 MLB ABS 好球帶判定。'}
            </Text>
          </View>

          {/* Video preview */}
          {videoUri && (
            <View style={styles.previewCard}>
              <VideoPlayer uri={videoUri} aspectRatio={9 / 16} style={styles.video} />
              {videoMeta && (
                <View style={styles.metaRow}>
                  <Text
                    style={styles.metaChip}
                    accessibilityLabel={`影片長度 ${videoMeta.durationS} 秒`}
                  >
                    ⏱ {videoMeta.durationS} s
                  </Text>
                  <Text
                    style={styles.metaChip}
                    accessibilityLabel={`影片大小 ${videoMeta.sizeMB} MB`}
                  >
                    💾 {videoMeta.sizeMB} MB
                  </Text>
                </View>
              )}
            </View>
          )}

          {/* Status message */}
          {statusMsg ? (
            <Text
              style={[
                styles.statusMsg,
                statusType === 'error' && { color: Colors.red },
                statusType === 'success' && { color: Colors.green },
              ]}
            >
              {statusMsg}
            </Text>
          ) : null}

          {/* Tips */}
          <View style={styles.tipsCard} accessible accessibilityRole="summary">
            <Text style={styles.tipsTitle}>拍攝建議（提升準度）</Text>
            <Text style={styles.tipsBody}>
              {'• 從捕手後方平視拍攝，鏡頭對齊投手出手點\n'}
              {'• 開啟慢動作（120fps 以上更佳）\n'}
              {'• 光線充足、背景單純，避免大量觀眾或光斑\n'}
              {'• 完整拍下從預備到接捕的所有動作'}
            </Text>
          </View>
        </View>
      )}

      {/* Analyze button */}
      <View style={[styles.actionWrap, { width: panelWidth }]}>
        <TouchableOpacity
          style={[styles.analyzeBtn, !canAnalyze && styles.analyzeBtnDisabled]}
          onPress={onAnalyze}
          disabled={!canAnalyze && (analyzing || !videoUri)}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityState={{ disabled: !canAnalyze, busy: analyzing }}
          accessibilityLabel={
            !videoUri ? '請先選擇影片'
              : !hasValidBatterHeight ? '請先輸入打者身高'
              : analyzing ? (isOffline ? '裝置分析進行中' : '伺服器分析進行中')
              : (isOffline ? '開始離線分析' : '開始線上分析')
          }
        >
          {analyzing ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <ActivityIndicator size="small" color="#fff" />
              <Text style={styles.analyzeBtnText}>
                {isOffline ? '裝置分析中…' : '上傳分析中…'}
              </Text>
            </View>
          ) : (
            <Text style={styles.analyzeBtnText}>
              {!videoUri ? '請先選擇影片' : !hasValidBatterHeight ? '輸入打者身高後開始' : (isOffline ? '開始離線分析' : '開始線上分析')}
            </Text>
          )}
        </TouchableOpacity>
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
    flexGrow: 1,
    alignItems: 'center',
    paddingTop: Spacing.md,
    paddingBottom: 80,
  },
  responsivePane: {
    alignSelf: 'center',
  },
  heroPanel: {
    backgroundColor: Colors.panel,
    borderRadius: Radius.xxl,
    padding: Spacing.xl,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    ...Shadows.card,
  },
  heroTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: Spacing.md,
  },
  eyebrow: {
    color: Colors.cyan,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.6,
    marginBottom: 6,
  },
  heroTitle: {
    color: Colors.textInverse,
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: 0,
  },
  heroCopy: {
    color: '#cbd5e1',
    fontSize: 14,
    lineHeight: 21,
    marginTop: Spacing.md,
  },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  liveBadgeText: {
    color: Colors.textInverse,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  heroMetricRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
    marginTop: Spacing.lg,
  },
  heroMetric: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    padding: Spacing.md,
  },
  heroMetricValue: {
    color: Colors.textInverse,
    fontSize: 18,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  heroMetricLabel: {
    color: '#94a3b8',
    fontSize: 10,
    marginTop: 3,
    fontWeight: '800',
  },
  modeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    marginTop: 12,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  modeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  modeText: {
    fontSize: 13,
    color: Colors.textMuted,
    fontWeight: '500',
  },
  dropZone: {
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: Colors.borderStrong,
    borderRadius: Radius.xxl,
    paddingVertical: 48,
    paddingHorizontal: 24,
    alignItems: 'center',
    marginTop: Spacing.md,
    backgroundColor: Colors.surface,
    ...Shadows.soft,
  },
  dropTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: Colors.text,
    marginBottom: 6,
  },
  dropSubtitle: {
    fontSize: 14,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  heightCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.xl,
    padding: 16,
    marginTop: Spacing.md,
    ...Shadows.soft,
  },
  heightHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    marginBottom: 10,
  },
  heightTitle: {
    fontSize: 14,
    fontWeight: '800',
    color: Colors.text,
  },
  heightBadge: {
    fontSize: 10,
    color: Colors.accent,
    fontWeight: '900',
    backgroundColor: 'rgba(37,99,235,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(37,99,235,0.22)',
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  heightInput: {
    height: 46,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.lg,
    paddingHorizontal: 12,
    fontSize: 17,
    color: Colors.text,
    backgroundColor: Colors.bg,
  },
  inputError: {
    borderColor: Colors.red,
  },
  heightHint: {
    marginTop: 8,
    fontSize: 12,
    lineHeight: 18,
    color: Colors.textMuted,
  },
  previewCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.xl,
    padding: 8,
    marginTop: Spacing.md,
    ...Shadows.soft,
  },
  video: {
    width: '100%',
    borderRadius: 12,
    backgroundColor: '#000',
  },
  metaRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    paddingHorizontal: 2,
  },
  metaChip: {
    fontSize: 12,
    color: Colors.textMuted,
    backgroundColor: Colors.bg,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  statusMsg: {
    fontSize: 14,
    color: Colors.textMuted,
    textAlign: 'center',
    marginTop: 10,
    paddingHorizontal: 16,
  },
  tipsCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.xl,
    padding: 20,
    marginTop: Spacing.md,
    ...Shadows.soft,
  },
  tipsTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.text,
    marginBottom: 6,
  },
  tipsBody: {
    fontSize: 13,
    color: Colors.textMuted,
    lineHeight: 21,
  },
  rawToggle: {
    alignSelf: 'center',
    marginTop: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  rawToggleText: {
    fontSize: 12,
    color: Colors.textMuted,
  },
  cancelBtn: {
    alignSelf: 'center',
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 22,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.4)',
    backgroundColor: 'rgba(239,68,68,0.08)',
  },
  cancelBtnText: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.red,
    letterSpacing: 0.3,
  },
  actionWrap: {
    alignSelf: 'center',
    paddingTop: 16,
  },
  analyzeBtn: {
    backgroundColor: Colors.accent,
    height: 54,
    borderRadius: Radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: 'rgba(37,99,235,0.25)',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 1,
    shadowRadius: 8,
    elevation: 4,
  },
  analyzeBtnDisabled: {
    backgroundColor: Colors.border,
    shadowOpacity: 0,
    elevation: 0,
  },
  analyzeBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
});
