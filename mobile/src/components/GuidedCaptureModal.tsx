import React, { useEffect, useRef, useState } from 'react';
import { Alert, Linking, Modal, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors, Radius, Spacing } from '../theme';

const MAX_RECORDING_S = 12;
const MAX_FILE_BYTES = 50 * 1024 * 1024;

interface Props {
  visible: boolean;
  onClose: () => void;
  onCaptured: (uri: string) => void;
}

export default function GuidedCaptureModal({ visible, onClose, onCaptured }: Props) {
  const cameraRef = useRef<CameraView | null>(null);
  const discardRecording = useRef(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [microphonePermission, requestMicrophonePermission] = useMicrophonePermissions();
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsedS, setElapsedS] = useState(0);

  useEffect(() => {
    if (!visible) {
      setReady(false);
      setElapsedS(0);
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || !recording) return;
    const startedAt = Date.now();
    const timer = setInterval(() => setElapsedS(Math.floor((Date.now() - startedAt) / 1000)), 250);
    return () => clearInterval(timer);
  }, [recording, visible]);

  const hasPermission = cameraPermission?.granted && microphonePermission?.granted;

  const requestPermissions = async () => {
    const camera = cameraPermission?.granted ? cameraPermission : await requestCameraPermission();
    const microphone = microphonePermission?.granted ? microphonePermission : await requestMicrophonePermission();
    if (!camera.granted || !microphone.granted) {
      Alert.alert('需要相機與麥克風權限', '相機用於拍攝投球；麥克風音訊可協助辨識接球時間。');
    }
  };

  const startRecording = async () => {
    if (!cameraRef.current || !ready || recording) return;
    discardRecording.current = false;
    setElapsedS(0);
    setRecording(true);
    try {
      const result = await cameraRef.current.recordAsync({
        maxDuration: MAX_RECORDING_S,
        maxFileSize: MAX_FILE_BYTES,
        codec: 'avc1',
      });
      if (result?.uri && !discardRecording.current) onCaptured(result.uri);
    } catch (error) {
      if (!discardRecording.current) Alert.alert('錄影失敗', error instanceof Error ? error.message : '請重新拍攝。');
    } finally {
      setRecording(false);
      if (discardRecording.current) onClose();
    }
  };

  const stopRecording = () => cameraRef.current?.stopRecording();

  const close = () => {
    if (!recording) {
      onClose();
      return;
    }
    discardRecording.current = true;
    cameraRef.current?.stopRecording();
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={close}>
      <View style={styles.container}>
        {hasPermission ? (
          <CameraView
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            active={visible}
            facing="back"
            mode="video"
            autofocus="on"
            videoQuality="1080p"
            videoStabilizationMode="standard"
            onCameraReady={() => setReady(true)}
          />
        ) : (
          <View style={styles.permissionPanel}>
            <Ionicons name="videocam-outline" size={42} color={Colors.accent} />
            <Text style={styles.permissionTitle}>開啟引導拍攝</Text>
            <Text style={styles.permissionBody}>需要相機與麥克風權限，影片只會交給裝置端分析。</Text>
            <TouchableOpacity style={styles.permissionButton} onPress={requestPermissions} accessibilityRole="button">
              <Text style={styles.permissionButtonText}>允許拍攝</Text>
            </TouchableOpacity>
            {(cameraPermission?.canAskAgain === false || microphonePermission?.canAskAgain === false) && (
              <TouchableOpacity style={styles.settingsButton} onPress={() => Linking.openSettings()} accessibilityRole="button">
                <Text style={styles.settingsButtonText}>前往系統設定</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        <SafeAreaView style={styles.overlay} pointerEvents="box-none">
          <View style={styles.topBar}>
            <TouchableOpacity style={styles.closeButton} onPress={close} accessibilityRole="button" accessibilityLabel="關閉引導拍攝">
              <Ionicons name="close" size={25} color="#fff" />
            </TouchableOpacity>
            <View style={styles.titlePill}>
              <Text style={styles.title}>投球引導拍攝</Text>
              <Text style={styles.timer}>{recording ? `REC ${elapsedS}s` : '最長 12 秒'}</Text>
            </View>
          </View>

          {hasPermission && (
            <View style={styles.guideArea} pointerEvents="none">
              <View style={styles.pitcherGuide}>
                <Text style={styles.guideLabel}>投手完整入鏡</Text>
              </View>
              <View style={styles.flightLine} />
              <View style={styles.plateGuide}>
                <Text style={styles.guideLabel}>本壘與接球點</Text>
              </View>
            </View>
          )}

          <View style={styles.bottomPanel} pointerEvents="box-none">
            <Text style={styles.tip}>手機固定、光線充足；投球前後各保留約 2 秒</Text>
            <TouchableOpacity
              style={[styles.recordButton, recording && styles.recordButtonActive, (!ready || !hasPermission) && styles.recordButtonDisabled]}
              onPress={recording ? stopRecording : startRecording}
              disabled={!ready || !hasPermission}
              accessibilityRole="button"
              accessibilityLabel={recording ? '停止錄影' : '開始錄影'}
              accessibilityState={{ disabled: !ready || !hasPermission }}
            >
              <View style={[styles.recordCore, recording && styles.stopCore]} />
            </TouchableOpacity>
            <Text style={styles.recordHint}>{recording ? '投球完成後停止' : ready ? '開始錄影' : '相機準備中'}</Text>
          </View>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#020617' },
  overlay: { flex: 1, justifyContent: 'space-between' },
  topBar: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm },
  closeButton: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(2,6,23,0.72)' },
  titlePill: { flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: Radius.xl, paddingHorizontal: Spacing.lg, backgroundColor: 'rgba(2,6,23,0.72)' },
  title: { color: '#fff', fontSize: 15, fontWeight: '900' },
  timer: { color: '#fda4af', fontSize: 11, fontWeight: '900', fontVariant: ['tabular-nums'] },
  guideArea: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pitcherGuide: { width: '56%', height: '38%', borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)', borderRadius: 999, alignItems: 'center', justifyContent: 'flex-start' },
  plateGuide: { width: '42%', height: 72, borderWidth: 2, borderColor: '#7dd3fc', borderRadius: Radius.lg, alignItems: 'center', justifyContent: 'flex-end' },
  flightLine: { width: 2, height: 70, backgroundColor: 'rgba(255,255,255,0.68)' },
  guideLabel: { color: '#fff', fontSize: 11, fontWeight: '900', backgroundColor: 'rgba(2,6,23,0.78)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5, overflow: 'hidden', marginTop: -14, marginBottom: -14 },
  bottomPanel: { alignItems: 'center', paddingHorizontal: Spacing.xl, paddingTop: Spacing.lg, paddingBottom: Spacing.md, backgroundColor: 'rgba(2,6,23,0.76)' },
  tip: { color: '#e2e8f0', fontSize: 12, fontWeight: '700', textAlign: 'center', marginBottom: Spacing.md },
  recordButton: { width: 76, height: 76, borderRadius: 38, borderWidth: 4, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  recordButtonActive: { borderColor: '#fda4af' },
  recordButtonDisabled: { opacity: 0.45 },
  recordCore: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#ef4444' },
  stopCore: { width: 28, height: 28, borderRadius: 6 },
  recordHint: { color: '#fff', fontSize: 11, fontWeight: '800', marginTop: Spacing.sm },
  permissionPanel: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, backgroundColor: Colors.bgDeep },
  permissionTitle: { color: '#fff', fontSize: 22, fontWeight: '900', marginTop: Spacing.lg },
  permissionBody: { color: '#cbd5e1', fontSize: 13, lineHeight: 20, textAlign: 'center', marginTop: Spacing.sm },
  permissionButton: { minWidth: 180, minHeight: 48, marginTop: Spacing.xl, borderRadius: Radius.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.accent },
  permissionButtonText: { color: '#fff', fontSize: 14, fontWeight: '900' },
  settingsButton: { minHeight: 44, justifyContent: 'center', marginTop: Spacing.sm },
  settingsButtonText: { color: '#7dd3fc', fontSize: 13, fontWeight: '800' },
});
