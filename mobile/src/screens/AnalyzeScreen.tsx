import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet,
  Alert, Linking, useWindowDimensions,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
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
import { getVideoMetadata, type VideoMetadata } from '../../modules/expo-speedgun';

const MAX_MB = 50;
const ABS_ZONE_TOP_RATIO = 0.535;
const ABS_ZONE_BOTTOM_RATIO = 0.27;
const LEGACY_ZONE_HEIGHT_M = 0.58;

type SelectedVideoMeta = {
  sizeMB: string;
  durationS: string;
  width?: number;
  height?: number;
  fps?: number;
  captureFps?: number;
  effectiveFps?: number;
  effectiveCaptureFps?: number;
  interpolationFactor?: number;
  totalFrames?: number;
  metadataPending?: boolean;
};

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
  const [videoMeta, setVideoMeta] = useState<SelectedVideoMeta | null>(null);
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
    const baseMeta: SelectedVideoMeta = {
      sizeMB,
      durationS,
      width: asset.width,
      height: asset.height,
      metadataPending: true,
    };
    setVideoMeta(baseMeta);
    getVideoMetadata(asset.uri)
      .then((meta: VideoMetadata) => {
        if (meta.error) {
          setVideoMeta((prev) => prev ? { ...prev, metadataPending: false } : prev);
          return;
        }
        setVideoMeta((prev) => prev ? {
          ...prev,
          durationS: meta.duration_s != null ? meta.duration_s.toFixed(1) : prev.durationS,
          width: meta.width ?? prev.width,
          height: meta.height ?? prev.height,
          fps: meta.fps,
          captureFps: meta.capture_fps,
          effectiveFps: meta.effective_fps,
          effectiveCaptureFps: meta.effective_capture_fps,
          interpolationFactor: meta.interpolation_factor,
          totalFrames: meta.total_frames,
          metadataPending: false,
        } : prev);
      })
      .catch(() => {
        setVideoMeta((prev) => prev ? { ...prev, metadataPending: false } : prev);
      });
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
  const zoneHeightCm = hasValidBatterHeight
    ? batterHeightM * (ABS_ZONE_TOP_RATIO - ABS_ZONE_BOTTOM_RATIO) * 100
    : null;
  const actionDisabled = analyzing || !videoUri;
  const needsHeight = !!videoUri && !hasValidBatterHeight;
  const videoFpsLabel = videoMeta?.fps
    ? `${videoMeta.fps}fps${videoMeta.captureFps && videoMeta.captureFps !== videoMeta.fps ? ` / capture ${videoMeta.captureFps}` : ''}`
    : videoMeta?.metadataPending ? '讀取中' : '待分析確認';
  const effectiveFpsLabel = videoMeta?.effectiveCaptureFps
    ? `${videoMeta.effectiveCaptureFps}fps`
    : videoMeta?.metadataPending ? '讀取中' : '分析時確認';
  const interpolationLabel = videoMeta?.interpolationFactor && videoMeta.interpolationFactor > 1
    ? `${videoMeta.interpolationFactor}x 補幀`
    : videoMeta?.interpolationFactor === 1
      ? '不補幀'
      : videoMeta?.metadataPending ? '讀取中' : '自動判斷';
  const resolutionLabel = videoMeta?.width && videoMeta?.height
    ? `${videoMeta.width} × ${videoMeta.height}`
    : '—';
  const readinessItems = [
    {
      key: 'video',
      icon: 'videocam-outline' as const,
      label: videoUri ? '影片已選擇' : '等待影片',
      value: videoMeta ? `${videoMeta.durationS}s / ${videoMeta.sizeMB}MB` : `上限 ${MAX_MB}MB`,
      done: !!videoUri,
    },
    {
      key: 'height',
      icon: 'body-outline' as const,
      label: hasValidBatterHeight ? '打者身高已設定' : '打者身高必填',
      value: hasValidBatterHeight ? `${batterHeightM.toFixed(2)}m / ABS ${zoneHeightCm?.toFixed(1)}cm` : '1.00-2.40m',
      done: hasValidBatterHeight,
    },
    {
      key: 'mode',
      icon: isOffline ? 'phone-portrait-outline' as const : 'cloud-outline' as const,
      label: isOffline ? '裝置端分析' : '伺服器分析',
      value: settings.moundDistanceM > 0 ? `距離 ${settings.moundDistanceM.toFixed(1)}m` : '距離自動估算',
      done: true,
    },
  ];

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
            style={styles.consoleHeader}
            accessible
            accessibilityLabel={`投球分析。模式：${isOffline ? '裝置端離線分析' : '伺服器分析'}。距離 ${settings.moundDistanceM > 0 ? settings.moundDistanceM.toFixed(1) + ' 公尺' : '自動估算'}。`}
          >
            <View style={styles.headerTopRow}>
              <View>
                <Text style={styles.eyebrow}>ANALYZE</Text>
                <Text style={styles.headerTitle}>投球分析控制台</Text>
              </View>
              <View style={styles.modePill}>
                <View style={[styles.modeDot, { backgroundColor: isOffline ? Colors.green : Colors.accent }]} />
                <Text style={styles.modePillText}>{isOffline ? '離線' : '雲端'}</Text>
              </View>
            </View>
            <View style={styles.readinessGrid}>
              {readinessItems.map((item) => (
                <View key={item.key} style={styles.readinessItem}>
                  <View style={[styles.readinessIcon, item.done && styles.readinessIconDone]}>
                    <Ionicons
                      name={item.done ? 'checkmark' : item.icon}
                      size={16}
                      color={item.done ? '#fff' : Colors.textMuted}
                    />
                  </View>
                  <View style={styles.readinessTextWrap}>
                    <Text style={styles.readinessLabel} numberOfLines={1}>{item.label}</Text>
                    <Text style={styles.readinessValue} numberOfLines={1}>{item.value}</Text>
                  </View>
                </View>
              ))}
            </View>
          </View>

          <View style={styles.workflowPanel}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionTitleWrap}>
                <Text style={styles.sectionTitle}>本次分析</Text>
                <Text style={styles.sectionSub} numberOfLines={1}>{videoUri ? videoName : '尚未選擇影片'}</Text>
              </View>
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={pickVideo}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel={videoUri ? '更換投球影片' : '從相簿選擇投球影片'}
              >
                <Ionicons name={videoUri ? 'swap-horizontal-outline' : 'add-outline'} size={18} color={Colors.accent} />
                <Text style={styles.secondaryButtonText}>{videoUri ? '更換' : '選片'}</Text>
              </TouchableOpacity>
            </View>

            {videoUri ? (
              <View style={styles.previewCard}>
                <VideoPlayer uri={videoUri} aspectRatio={9 / 16} style={styles.video} />
                {videoMeta && (
                  <View style={styles.metaRow}>
                    <View style={styles.metaChip} accessibilityLabel={`影片長度 ${videoMeta.durationS} 秒`}>
                      <Ionicons name="time-outline" size={14} color={Colors.textMuted} />
                      <Text style={styles.metaChipText}>{videoMeta.durationS}s</Text>
                    </View>
                    <View style={styles.metaChip} accessibilityLabel={`影片大小 ${videoMeta.sizeMB} MB`}>
                      <Ionicons name="server-outline" size={14} color={Colors.textMuted} />
                      <Text style={styles.metaChipText}>{videoMeta.sizeMB}MB</Text>
                    </View>
                  </View>
                )}
                {videoMeta && (
                  <View style={styles.specPanel}>
                    <View style={styles.specHeaderRow}>
                      <Text style={styles.specTitle}>影片規格</Text>
                      <Text style={styles.specBadge}>{interpolationLabel}</Text>
                    </View>
                    <View style={styles.specGrid}>
                      <View style={styles.specItem}>
                        <Text style={styles.specValue}>{videoFpsLabel}</Text>
                        <Text style={styles.specLabel}>原始 FPS</Text>
                      </View>
                      <View style={styles.specItem}>
                        <Text style={styles.specValue}>{effectiveFpsLabel}</Text>
                        <Text style={styles.specLabel}>分析 FPS</Text>
                      </View>
                      <View style={styles.specItem}>
                        <Text style={styles.specValue}>{resolutionLabel}</Text>
                        <Text style={styles.specLabel}>解析度</Text>
                      </View>
                      <View style={styles.specItem}>
                        <Text style={styles.specValue}>{videoMeta.totalFrames ?? '—'}</Text>
                        <Text style={styles.specLabel}>原始幀數</Text>
                      </View>
                    </View>
                  </View>
                )}
              </View>
            ) : (
              <TouchableOpacity
                style={styles.emptyPicker}
                onPress={pickVideo}
                activeOpacity={0.72}
                accessibilityRole="button"
                accessibilityLabel="從相簿選擇投球影片"
                accessibilityHint={`最大 ${MAX_MB} MB`}
              >
                <View style={styles.emptyPickerIcon}>
                  <Ionicons name="videocam-outline" size={30} color={Colors.accent} />
                </View>
                <Text style={styles.emptyPickerTitle}>選擇投球影片</Text>
                <Text style={styles.emptyPickerSub}>MP4 / MOV, {MAX_MB}MB 以下</Text>
              </TouchableOpacity>
            )}

            <View style={styles.inputPanel}>
              <View style={styles.inputHeader}>
                <View>
                  <Text style={styles.inputTitle}>打者身高</Text>
                  <Text style={styles.inputSub}>MLB ABS 好球帶高度</Text>
                </View>
                <View style={styles.absBadge}>
                  <Text style={styles.absBadgeText}>ABS</Text>
                </View>
              </View>
              <View style={[styles.heightInputWrap, batterHeightError && styles.inputError]}>
                <TextInput
                  style={styles.heightInput}
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
                  placeholder="1.78"
                  placeholderTextColor={Colors.textMuted}
                  returnKeyType="done"
                  accessibilityLabel="打者身高，公尺，開始分析前必填"
                />
                <Text style={styles.inputUnit}>m</Text>
              </View>
              <View style={styles.zonePreviewRow}>
                <View style={styles.zonePreviewItem}>
                  <Text style={styles.zonePreviewValue}>43.2</Text>
                  <Text style={styles.zonePreviewLabel}>寬 cm</Text>
                </View>
                <View style={styles.zonePreviewDivider} />
                <View style={styles.zonePreviewItem}>
                  <Text style={styles.zonePreviewValue}>{zoneHeightCm ? zoneHeightCm.toFixed(1) : '-'}</Text>
                  <Text style={styles.zonePreviewLabel}>高 cm</Text>
                </View>
                <View style={styles.zonePreviewDivider} />
                <View style={styles.zonePreviewItem}>
                  <Text style={styles.zonePreviewValue}>27-53.5</Text>
                  <Text style={styles.zonePreviewLabel}>身高 %</Text>
                </View>
              </View>
              <Text style={[styles.heightHint, batterHeightError && { color: Colors.red }]}>
                {batterHeightError
                  ? '請輸入 1.00 到 2.40 公尺之間的身高'
                  : needsHeight ? '輸入後即可開始分析。' : '好球帶會套用到本次分析與疊圖。'}
              </Text>
            </View>

            <View style={styles.capturePanel}>
              {[
                ['scan-outline', '捕手後方', '鏡頭對齊本壘中心'],
                ['sunny-outline', '光線穩定', '避免背光與強反光'],
                ['speedometer-outline', '高幀率', '慢動作影片更準'],
              ].map(([icon, title, sub]) => (
                <View key={title} style={styles.captureItem}>
                  <Ionicons name={icon as keyof typeof Ionicons.glyphMap} size={18} color={Colors.textMuted} />
                  <View style={styles.captureText}>
                    <Text style={styles.captureTitle}>{title}</Text>
                    <Text style={styles.captureSub}>{sub}</Text>
                  </View>
                </View>
              ))}
            </View>

            {statusMsg ? (
              <View style={[
                styles.statusCard,
                statusType === 'error' && styles.statusCardError,
                statusType === 'success' && styles.statusCardSuccess,
              ]}>
                <Ionicons
                  name={statusType === 'error' ? 'alert-circle-outline' : statusType === 'success' ? 'checkmark-circle-outline' : 'information-circle-outline'}
                  size={18}
                  color={statusType === 'error' ? Colors.red : statusType === 'success' ? Colors.green : Colors.textMuted}
                />
                <Text
                  style={[
                    styles.statusMsg,
                    statusType === 'error' && { color: Colors.red },
                    statusType === 'success' && { color: Colors.green },
                  ]}
                >
                  {statusMsg}
                </Text>
              </View>
            ) : null}
          </View>
        </View>
      )}

      {/* Analyze button */}
      <View style={[styles.actionWrap, { width: panelWidth }]}>
        <TouchableOpacity
          style={[
            styles.analyzeBtn,
            actionDisabled && styles.analyzeBtnDisabled,
            needsHeight && styles.analyzeBtnPending,
          ]}
          onPress={onAnalyze}
          disabled={actionDisabled}
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
  consoleHeader: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.xxl,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    ...Shadows.soft,
  },
  headerTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.md,
  },
  eyebrow: {
    color: Colors.textMuted,
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 1.2,
    marginBottom: 4,
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 0,
  },
  modePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  modePillText: {
    color: Colors.text,
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  readinessGrid: {
    gap: Spacing.sm,
    marginTop: Spacing.lg,
  },
  readinessItem: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  readinessIcon: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  readinessIconDone: {
    backgroundColor: Colors.green,
    borderColor: Colors.green,
  },
  readinessTextWrap: {
    flex: 1,
    minWidth: 0,
  },
  readinessLabel: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '800',
  },
  readinessValue: {
    color: Colors.textMuted,
    fontSize: 11,
    marginTop: 2,
    fontVariant: ['tabular-nums'],
  },
  workflowPanel: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.xxl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
    marginTop: Spacing.md,
    ...Shadows.soft,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
    marginBottom: Spacing.md,
  },
  sectionTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  sectionTitle: {
    color: Colors.text,
    fontSize: 18,
    fontWeight: '900',
  },
  sectionSub: {
    color: Colors.textMuted,
    fontSize: 12,
    marginTop: 3,
  },
  secondaryButton: {
    minHeight: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderRadius: Radius.lg,
    backgroundColor: 'rgba(14,165,233,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(14,165,233,0.22)',
    paddingHorizontal: 12,
  },
  secondaryButtonText: {
    color: Colors.accent,
    fontSize: 13,
    fontWeight: '800',
  },
  modeDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  emptyPicker: {
    minHeight: 170,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: Colors.borderStrong,
    borderRadius: Radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface2,
    padding: Spacing.xl,
  },
  emptyPickerIcon: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(14,165,233,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(14,165,233,0.20)',
    marginBottom: Spacing.md,
  },
  emptyPickerTitle: {
    color: Colors.text,
    fontSize: 17,
    fontWeight: '900',
  },
  emptyPickerSub: {
    color: Colors.textMuted,
    fontSize: 12,
    marginTop: 4,
  },
  inputPanel: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    marginTop: Spacing.md,
  },
  inputHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.md,
    marginBottom: Spacing.sm,
  },
  inputTitle: {
    fontSize: 14,
    fontWeight: '900',
    color: Colors.text,
  },
  inputSub: {
    fontSize: 11,
    color: Colors.textMuted,
    marginTop: 2,
  },
  absBadge: {
    borderRadius: 999,
    backgroundColor: 'rgba(14,165,233,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(14,165,233,0.24)',
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  absBadgeText: {
    fontSize: 10,
    color: Colors.accent,
    fontWeight: '900',
    letterSpacing: 0.8,
  },
  heightInputWrap: {
    height: 52,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
  },
  heightInput: {
    flex: 1,
    minWidth: 0,
    fontSize: 22,
    fontWeight: '800',
    color: Colors.text,
    fontVariant: ['tabular-nums'],
    paddingVertical: 0,
  },
  inputUnit: {
    color: Colors.textMuted,
    fontSize: 14,
    fontWeight: '800',
  },
  inputError: {
    borderColor: Colors.red,
  },
  heightHint: {
    marginTop: Spacing.sm,
    fontSize: 12,
    lineHeight: 18,
    color: Colors.textMuted,
  },
  zonePreviewRow: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    marginTop: Spacing.sm,
  },
  zonePreviewItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.xs,
  },
  zonePreviewValue: {
    color: Colors.text,
    fontSize: 15,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  zonePreviewLabel: {
    color: Colors.textMuted,
    fontSize: 10,
    marginTop: 3,
    fontWeight: '700',
  },
  zonePreviewDivider: {
    width: 1,
    height: 34,
    backgroundColor: Colors.border,
  },
  previewCard: {
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.xl,
    padding: 8,
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: Colors.bg,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  metaChipText: {
    fontSize: 12,
    color: Colors.textMuted,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  specPanel: {
    marginTop: Spacing.sm,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    padding: Spacing.md,
  },
  specHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  specTitle: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '900',
  },
  specBadge: {
    color: Colors.accent,
    fontSize: 11,
    fontWeight: '900',
    backgroundColor: 'rgba(14,165,233,0.10)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    overflow: 'hidden',
  },
  specGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  specItem: {
    flexBasis: '47%',
    flexGrow: 1,
    minHeight: 56,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface2,
    paddingHorizontal: Spacing.sm,
    paddingVertical: Spacing.sm,
    justifyContent: 'center',
  },
  specValue: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  specLabel: {
    color: Colors.textMuted,
    fontSize: 10,
    fontWeight: '700',
    marginTop: 3,
  },
  capturePanel: {
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  captureItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    minHeight: 42,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: Spacing.md,
  },
  captureText: {
    flex: 1,
    minWidth: 0,
  },
  captureTitle: {
    color: Colors.text,
    fontSize: 12,
    fontWeight: '900',
  },
  captureSub: {
    color: Colors.textMuted,
    fontSize: 11,
    marginTop: 1,
  },
  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface2,
    padding: Spacing.md,
    marginTop: Spacing.md,
  },
  statusCardError: {
    backgroundColor: 'rgba(239,68,68,0.08)',
    borderColor: 'rgba(239,68,68,0.24)',
  },
  statusCardSuccess: {
    backgroundColor: 'rgba(16,185,129,0.08)',
    borderColor: 'rgba(16,185,129,0.24)',
  },
  statusMsg: {
    flex: 1,
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
  analyzeBtnPending: {
    backgroundColor: Colors.yellow,
  },
  analyzeBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
});
