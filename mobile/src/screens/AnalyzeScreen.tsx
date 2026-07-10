import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet,
  Alert, Linking, useWindowDimensions,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useNavigation } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Layout, Radius, Spacing } from '../theme';
import VideoPlayer from '../components/VideoPlayer';
import { useSettings } from '../context/SettingsContext';
import { useResult } from '../context/ResultContext';
import { useOfflineAnalysis } from '../hooks/useOfflineAnalysis';
import AnalysisProgress from '../components/AnalysisProgress';
import { friendlyError, isCancellation } from '../utils/errors';
import { isManualDistanceCalibrated } from '../types';
import type { StrikeZoneCalibration } from '../types';
import { getVideoMetadata, type VideoMetadata } from '../../modules/expo-speedgun';

const MAX_MB = 50;
const ABS_ZONE_TOP_RATIO = 0.535;
const ABS_ZONE_BOTTOM_RATIO = 0.27;
const LEGACY_ZONE_HEIGHT_M = 0.58;
const BATTER_HEIGHT_PRESETS = ['1.65', '1.75', '1.85'];

function checkFileSize(fileSize: number, maxMB = MAX_MB) {
  if (fileSize > maxMB * 1024 * 1024) {
    throw new Error(`影片檔案過大（${(fileSize / 1024 / 1024).toFixed(1)} MB）。請先壓縮至 ${maxMB} MB 以內。`);
  }
}

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

  const batterHeightM = Number.parseFloat(batterHeightText);
  const hasValidBatterHeight = Number.isFinite(batterHeightM) && batterHeightM >= 1.0 && batterHeightM <= 2.4;
  const hasDistanceCalibration = isManualDistanceCalibrated(settings.moundDistanceM);
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
    const initEntry = { msg: '本機分析已開始', isError: false };
    rawLogsRef.current = [...rawLogsRef.current.slice(-200), initEntry];
    setRawLogs(rawLogsRef.current);
    setUploadPct(100);
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
        setStatusMsg(friendlyError(err, { action: '本機分析' }) ?? '本機分析失敗。');
        setStatusType('error');
      }
    } finally {
      setAnalyzing(false);
    }
  };

  const onAnalyze = async () => {
    setHeightTouched(true);
    if (!hasDistanceCalibration) {
      setStatusMsg('請先在設定完成手動投打距離校正；未校正的距離不會產生正式球速。');
      setStatusType('error');
      Alert.alert(
        '需要投打距離校正',
        '請量測投手板前緣到本壘板後尖端的距離，並在設定中輸入 3–30 公尺的值。球速會以此距離扣除跨步補償計算。',
        [
          { text: '稍後', style: 'cancel' },
          { text: '前往設定', onPress: () => navigation.navigate('Settings') },
        ],
      );
      return;
    }
    if (!hasValidBatterHeight) {
      setStatusMsg('請先輸入打者身高（公尺），系統會依 MLB ABS 規則計算好球帶。');
      setStatusType('error');
      return;
    }

    await onAnalyzeOffline();
  };
  const panelWidth = Math.min(width - 32, Layout.maxWidth);
  const zoneHeightCm = hasValidBatterHeight
    ? batterHeightM * (ABS_ZONE_TOP_RATIO - ABS_ZONE_BOTTOM_RATIO) * 100
    : null;
  const actionDisabled = analyzing || !videoUri;
  const needsDistance = !!videoUri && !hasDistanceCalibration;
  const needsHeight = !!videoUri && !hasValidBatterHeight;
  const resolutionLabel = videoMeta?.width && videoMeta?.height
    ? `${videoMeta.width} × ${videoMeta.height}`
    : '—';
  const actionLabel = !videoUri
    ? '請先選擇影片'
    : !hasDistanceCalibration
      ? '完成距離校正後開始'
    : !hasValidBatterHeight
      ? '輸入打者身高後開始'
      : '開始分析';
  const actionIcon: keyof typeof Ionicons.glyphMap = !videoUri
    ? 'videocam-outline'
    : !hasDistanceCalibration
      ? 'resize-outline'
    : !hasValidBatterHeight
      ? 'body-outline'
      : 'phone-portrait-outline';

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
      {analyzing ? (
        <View style={[styles.responsivePane, { width: panelWidth, marginTop: 16 }]}>
          <AnalysisProgress
            progressPct={uploadPct}
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
        </View>
      ) : (
        <View style={[styles.responsivePane, { width: panelWidth }]}>
          <View
            style={styles.pageHeader}
            accessible
            accessibilityLabel={`投球分析會在此裝置完成。投打距離${hasDistanceCalibration ? `已手動校正為 ${settings.moundDistanceM.toFixed(2)} 公尺` : '尚未校正'}。`}
          >
            <View style={styles.headerTopRow}>
              <View>
                <Text style={styles.headerTitle}>分析一球</Text>
                <Text style={styles.headerSub}>選擇影片，確認設定後開始。</Text>
              </View>
              <View style={styles.modePill}>
                <View style={[styles.modeDot, { backgroundColor: Colors.green }]} />
                <Text style={styles.modePillText}>本機運算</Text>
              </View>
            </View>
          </View>

          <View style={styles.workflowPanel}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionTitleWrap}>
                <Text style={styles.sectionTitle}>影片</Text>
                <Text style={styles.sectionSub} numberOfLines={1}>{videoUri ? videoName : `MP4 或 MOV，最多 ${MAX_MB}MB`}</Text>
              </View>
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={pickVideo}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel={videoUri ? '更換投球影片' : '從相簿選擇投球影片'}
              >
                <Ionicons name={videoUri ? 'swap-horizontal-outline' : 'add-outline'} size={18} color={Colors.accent} />
                <Text style={styles.secondaryButtonText}>{videoUri ? '更換' : '選擇'}</Text>
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
                      <Ionicons name="folder-outline" size={14} color={Colors.textMuted} />
                      <Text style={styles.metaChipText}>{videoMeta.sizeMB}MB</Text>
                    </View>
                  </View>
                )}
                {videoMeta && (
                  <View style={styles.videoDetails}>
                    <Text style={styles.videoDetailsText}>
                      {resolutionLabel} · {videoMeta.fps ? `${videoMeta.fps} fps` : '讀取影片資訊中'}
                    </Text>
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
                <Text style={styles.emptyPickerTitle}>選擇影片</Text>
                <Text style={styles.emptyPickerSub}>從相簿加入一段投球影片</Text>
              </TouchableOpacity>
            )}

            <View style={styles.inputPanel}>
              <View style={styles.inputHeader}>
                <View>
                  <Text style={styles.inputTitle}>打者身高</Text>
                  <Text style={styles.inputSub}>用來計算本次好球帶</Text>
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
              <View style={styles.presetRow}>
                {BATTER_HEIGHT_PRESETS.map((preset) => {
                  const selected = batterHeightText === preset;
                  return (
                    <TouchableOpacity
                      key={preset}
                      style={[styles.presetChip, selected && styles.presetChipActive]}
                      onPress={() => {
                        setBatterHeightText(preset);
                        setHeightTouched(true);
                        if (statusType === 'error') {
                          setStatusMsg('');
                          setStatusType('');
                        }
                      }}
                      activeOpacity={0.75}
                      accessibilityRole="button"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`套用打者身高 ${preset} 公尺`}
                    >
                      <Text style={[styles.presetChipText, selected && styles.presetChipTextActive]}>
                        {preset}m
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              <Text style={[styles.heightHint, batterHeightError && { color: Colors.red }]}>
                {batterHeightError
                  ? '請輸入 1.00 到 2.40 公尺之間的身高'
                  : needsHeight ? '輸入後即可開始分析。' : `好球帶高度約 ${zoneHeightCm?.toFixed(1)} cm。`}
              </Text>
            </View>

            <View style={[styles.distanceCalibrationCard, hasDistanceCalibration && styles.distanceCalibrationCardDone]}>
              <View style={styles.distanceCalibrationIcon}>
                <Ionicons
                  name={hasDistanceCalibration ? 'checkmark-circle' : 'resize-outline'}
                  size={21}
                  color={hasDistanceCalibration ? Colors.green : Colors.accent}
                />
              </View>
              <View style={styles.distanceCalibrationCopy}>
                <Text style={styles.distanceCalibrationTitle}>
                  {hasDistanceCalibration ? `投打距離 ${settings.moundDistanceM.toFixed(2)}m` : '設定投打距離'}
                </Text>
                <Text style={styles.distanceCalibrationText}>
                  {hasDistanceCalibration
                    ? '已完成校正，可用於球速計算。'
                    : '完成校正後即可開始球速分析。'}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.distanceCalibrationButton}
                onPress={() => navigation.navigate('Settings')}
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel={hasDistanceCalibration ? '修改投打距離校正' : '前往設定投打距離校正'}
              >
                <Text style={styles.distanceCalibrationButtonText}>{hasDistanceCalibration ? '修改' : '校正'}</Text>
              </TouchableOpacity>
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
            (needsHeight || needsDistance) && styles.analyzeBtnPending,
          ]}
          onPress={onAnalyze}
          disabled={actionDisabled}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityState={{ disabled: actionDisabled, busy: analyzing }}
          accessibilityLabel={
            !videoUri ? '請先選擇影片'
              : !hasDistanceCalibration ? '請先完成投打距離校正'
              : !hasValidBatterHeight ? '請先輸入打者身高'
              : analyzing ? '裝置分析進行中'
              : '開始分析'
          }
        >
          {analyzing ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <ActivityIndicator size="small" color="#fff" />
              <Text style={styles.analyzeBtnText}>
                裝置分析中…
              </Text>
            </View>
          ) : (
            <View style={styles.buttonInner}>
              <Ionicons name={actionIcon} size={20} color="#fff" />
              <Text style={styles.analyzeBtnText}>{actionLabel}</Text>
            </View>
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
    paddingTop: Spacing.xl,
    paddingBottom: 80,
  },
  responsivePane: {
    alignSelf: 'center',
  },
  pageHeader: {
    paddingHorizontal: Spacing.xs,
    marginBottom: Spacing.lg,
  },
  headerTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.md,
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 23,
    fontWeight: '800',
    letterSpacing: 0,
  },
  headerSub: {
    color: Colors.textMuted,
    fontSize: 13,
    marginTop: 4,
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
  workflowPanel: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
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
    minHeight: 156,
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
    paddingTop: Spacing.lg,
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
  presetRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  presetChip: {
    minHeight: 44,
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
  },
  presetChipActive: {
    borderColor: Colors.accent,
    backgroundColor: 'rgba(14,165,233,0.10)',
  },
  presetChipText: {
    color: Colors.textMuted,
    fontSize: 12,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  presetChipTextActive: {
    color: Colors.accent,
  },
  heightHint: {
    marginTop: Spacing.sm,
    fontSize: 12,
    lineHeight: 18,
    color: Colors.textMuted,
  },
  distanceCalibrationCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    marginTop: Spacing.md,
    padding: Spacing.md,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(14,165,233,0.28)',
    backgroundColor: 'rgba(14,165,233,0.06)',
  },
  distanceCalibrationCardDone: {
    borderColor: 'rgba(34,197,94,0.30)',
    backgroundColor: 'rgba(34,197,94,0.06)',
  },
  distanceCalibrationIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
  },
  distanceCalibrationCopy: {
    flex: 1,
    minWidth: 0,
  },
  distanceCalibrationTitle: {
    color: Colors.text,
    fontSize: 13,
    fontWeight: '900',
  },
  distanceCalibrationText: {
    color: Colors.textMuted,
    fontSize: 11,
    lineHeight: 16,
    marginTop: 2,
  },
  distanceCalibrationButton: {
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.accent,
    paddingHorizontal: 10,
  },
  distanceCalibrationButtonText: {
    color: Colors.accent,
    fontSize: 12,
    fontWeight: '900',
  },
  previewCard: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.lg,
    padding: Spacing.sm,
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
  videoDetails: {
    marginTop: Spacing.sm,
    paddingHorizontal: Spacing.xs,
  },
  videoDetailsText: {
    color: Colors.textMuted,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
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
  buttonInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
});
