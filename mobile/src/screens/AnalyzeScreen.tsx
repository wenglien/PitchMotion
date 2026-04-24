import React, { useState, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator, StyleSheet,
  Alert, Linking,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as FileSystem from 'expo-file-system';
import { useNavigation } from '@react-navigation/native';
import { Colors } from '../theme';
import VideoPlayer from '../components/VideoPlayer';
import { useSettings } from '../context/SettingsContext';
import { useResult } from '../context/ResultContext';
import { analyzeVideo, checkFileSize, checkHealth } from '../api';
import { parseLog } from '../utils/pipelineStages';
import { useOfflineAnalysis } from '../hooks/useOfflineAnalysis';
import AnalysisProgress from '../components/AnalysisProgress';

const MAX_MB = 50;
const DEBUG_ENDPOINT = 'http://127.0.0.1:7817/ingest/2f29f838-8dcb-4b7f-b65b-0aaee978ffe2';
const DEBUG_SESSION_ID = 'cfe8be';
const DEBUG_FILE_URI = `${FileSystem.documentDirectory ?? ''}debug-cfe8be.log`;

function debugLog(hypothesisId: string, location: string, message: string, data: Record<string, unknown> = {}) {
  const payload = {
    sessionId: DEBUG_SESSION_ID,
    runId: `analyze-screen-${Date.now()}`,
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  // #region agent log
  fetch(DEBUG_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Debug-Session-Id': DEBUG_SESSION_ID,
    },
    body: JSON.stringify(payload),
  }).catch(() => {});
  if (FileSystem.documentDirectory) {
    const line = `${JSON.stringify(payload)}\n`;
    FileSystem.writeAsStringAsync(DEBUG_FILE_URI, line, { append: true }).catch(() => {});
  }
  // #region agent log
  console.log(`[DBG-cfe8be] ${location} ${message} ${JSON.stringify(data)}`);
  // #endregion
  // #endregion
}

export default function AnalyzeScreen() {
  const { settings } = useSettings();
  const { setResult, addPitch, setAnalysisLogs } = useResult();
  const { analyze: analyzeOffline } = useOfflineAnalysis();
  const navigation = useNavigation<any>();

  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [videoName, setVideoName] = useState<string>('video.mp4');
  const [videoMeta, setVideoMeta] = useState<{ sizeMB: string; durationS: string } | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const [stageMessages, setStageMessages] = useState<string[]>([]);
  const [rawLogs, setRawLogs] = useState<{ msg: string; isError: boolean }[]>([]);
  const rawLogsRef = useRef<{ msg: string; isError: boolean }[]>([]);
  const [showRaw, setShowRaw] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [statusType, setStatusType] = useState<'' | 'error' | 'success'>('');

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
    if (!videoUri || analyzing) return;
    debugLog('H6', 'AnalyzeScreen.tsx:onAnalyzeOffline', 'Offline analysis invoked', {
      analysisMode: settings.analysisMode,
      hasVideoUri: !!videoUri,
    });
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
      // #region agent log
      console.log('[DBG-cfe8be] onAnalyzeOffline start');
      // #endregion
      const result = await analyzeOffline(
        videoUri,
        {
          moundDistanceM: settings.moundDistanceM,
          strideCorrectionM: settings.strideCorrectionM,
          confThreshold: settings.confThreshold,
          pitcherHeightM: settings.pitcherHeightM,
          strikeZone: settings.strikeZone,
        },
        {
          onStage: (stageId) => {
            if (stageId === 'overlay' || stageId === 'done') {
              debugLog('H6', 'AnalyzeScreen.tsx:onAnalyzeOffline:onStage', 'Offline stage event', { stageId });
            }
            setCurrentStage(stageId);
          },
          onMessage: (msg) => {
            if (/overlay|encoding|生成/i.test(msg)) {
              debugLog('H6', 'AnalyzeScreen.tsx:onAnalyzeOffline:onMessage', 'Offline overlay message', { msg });
            }
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
      // #region agent log
      console.log(`[DBG-cfe8be] onAnalyzeOffline error ${err?.message || ''}`);
      // #endregion
      setStatusMsg(err.message || '離線分析失敗。');
      setStatusType('error');
    } finally {
      setAnalyzing(false);
    }
  };

  const onAnalyzeOnline = async () => {
    if (!videoUri || analyzing) return;
    debugLog('H7', 'AnalyzeScreen.tsx:onAnalyzeOnline', 'Online analysis invoked', {
      analysisMode: settings.analysisMode,
      hasVideoUri: !!videoUri,
      backendUrl: settings.backendUrl,
    });
    setAnalyzing(true);
    resetAnalysis();
    const initEntry2 = { msg: '[DEBUG] mode=online', isError: false };
    rawLogsRef.current = [...rawLogsRef.current.slice(-200), initEntry2];
    setRawLogs(rawLogsRef.current);
    setStatusMsg('');
    setStatusType('');

    try {
      // #region agent log
      console.log('[DBG-cfe8be] onAnalyzeOnline start');
      // #endregion
      const result = await analyzeVideo(
        settings.backendUrl,
        videoUri,
        videoName,
        {
          moundDistanceM: settings.moundDistanceM,
          strideCorrectionM: settings.strideCorrectionM,
          confThreshold: settings.confThreshold,
          strikeZone: settings.strikeZone,
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
              if (parsed.stageId === 'overlay' || parsed.stageId === 'done') {
                debugLog('H7', 'AnalyzeScreen.tsx:onAnalyzeOnline:parsedStage', 'Online parsed stage', {
                  stageId: parsed.stageId,
                  userMsg: parsed.userMsg,
                });
              }
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
            if (/overlay|encoding|ffmpeg|error|failed/i.test(raw)) {
              debugLog('H7', 'AnalyzeScreen.tsx:onAnalyzeOnline:rawLog', 'Online raw technical log', {
                level: entry.level,
                raw,
              });
            }
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
      // #region agent log
      console.log(`[DBG-cfe8be] onAnalyzeOnline error ${err?.message || ''}`);
      // #endregion
      setStatusMsg(err.message || '分析失敗。');
      setStatusType('error');
    } finally {
      setAnalyzing(false);
    }
  };

  const onAnalyze = async () => {
    if (settings.analysisMode === 'offline') {
      await onAnalyzeOffline();
      return;
    }

    // For simulator/dev setups, backend may be unavailable; fall back to offline
    // so users can still get overlay output instead of a stalled online flow.
    const healthy = await checkHealth(settings.backendUrl);
    if (!healthy) {
      debugLog('H7', 'AnalyzeScreen.tsx:onAnalyze', 'Backend health check failed, fallback to offline', {
        backendUrl: settings.backendUrl,
      });
      setRawLogs((prev) => [...prev.slice(-200), { msg: `ℹ️ 後端無法連線，自動改用裝置端離線分析`, isError: false }]);
      await onAnalyzeOffline();
      return;
    }

    await onAnalyzeOnline();
  };
  const isOffline = settings.analysisMode === 'offline';

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" nestedScrollEnabled>
      {analyzing ? (
        <View style={{ marginTop: 16 }}>
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
          >
            <Text style={styles.rawToggleText}>
              {showRaw ? '▲ 隱藏技術詳情' : '▼ 查看技術詳情'}
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
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
          >
            <Text style={styles.dropTitle}>
              {videoUri ? 'Video selected' : 'Select pitch video'}
            </Text>
            <Text style={styles.dropSubtitle}>
              {videoUri ? 'Tap to change video' : `Tap to choose from library\nMax ${MAX_MB} MB`}
            </Text>
          </TouchableOpacity>

          {/* Video preview */}
          {videoUri && (
            <View style={styles.previewCard}>
              <VideoPlayer uri={videoUri} style={styles.video} />
              {videoMeta && (
                <View style={styles.metaRow}>
                  <Text style={styles.metaChip}>⏱ {videoMeta.durationS} s</Text>
                  <Text style={styles.metaChip}>💾 {videoMeta.sizeMB} MB</Text>
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
          <View style={styles.tipsCard}>
            <Text style={styles.tipsTitle}>Tips for best results</Text>
            <Text style={styles.tipsBody}>
              {'• Film from behind the pitcher or catcher at eye level\n'}
              {'• Use slow-motion mode (120fps+) if available\n'}
              {'• Ensure good lighting and a clear background\n'}
              {'• Keep the full pitching motion in frame'}
            </Text>
          </View>
        </>
      )}

      {/* Analyze button */}
      <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
        <TouchableOpacity
          style={[styles.analyzeBtn, (!videoUri || analyzing) && styles.analyzeBtnDisabled]}
          onPress={onAnalyze}
          disabled={!videoUri || analyzing}
          activeOpacity={0.8}
        >
          {analyzing ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <ActivityIndicator size="small" color="#fff" />
              <Text style={styles.analyzeBtnText}>
                {isOffline ? '裝置分析中…' : 'Analysing…'}
              </Text>
            </View>
          ) : (
            <Text style={styles.analyzeBtnText}>
              {isOffline ? '開始離線分析' : 'Analyse Pitch Speed'}
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
    paddingBottom: 80,
  },
  modeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
    marginHorizontal: 16,
    marginTop: 12,
    backgroundColor: Colors.surface,
    borderRadius: 10,
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
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: Colors.border,
    borderRadius: 18,
    paddingVertical: 48,
    paddingHorizontal: 24,
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 8,
    backgroundColor: Colors.surface,
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
  previewCard: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 16,
    padding: 8,
    marginHorizontal: 16,
    marginTop: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
  },
  video: {
    width: '100%',
    height: 240,
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
    borderRadius: 16,
    padding: 20,
    marginHorizontal: 16,
    marginTop: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
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
  analyzeBtn: {
    backgroundColor: Colors.accent,
    height: 52,
    borderRadius: 14,
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
