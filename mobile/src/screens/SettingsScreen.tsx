import React, { useState } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity,
  KeyboardAvoidingView, Platform, ActivityIndicator, StyleSheet,
} from 'react-native';
import { Colors } from '../theme';
import { useSettings } from '../context/SettingsContext';
import { checkHealth } from '../api';
import type { AnalysisMode } from '../types';

export default function SettingsScreen() {
  const { settings, updateSettings } = useSettings();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<boolean | null>(null);

  // Local string state so decimal-point mid-input isn't swallowed by parseFloat
  const [moundText, setMoundText] = useState(
    settings.moundDistanceM > 0 ? String(settings.moundDistanceM) : '',
  );
  const [strideText, setStrideText] = useState(String(settings.strideCorrectionM));
  const [confText, setConfText] = useState(String(settings.confThreshold));
  const [pitcherHeightText, setPitcherHeightText] = useState(
    settings.pitcherHeightM != null ? String(settings.pitcherHeightM) : '',
  );
  const [zxMinText, setZxMinText] = useState(settings.strikeZone ? String(settings.strikeZone.xMin) : '');
  const [zxMaxText, setZxMaxText] = useState(settings.strikeZone ? String(settings.strikeZone.xMax) : '');
  const [zyMinText, setZyMinText] = useState(settings.strikeZone ? String(settings.strikeZone.yMin) : '');
  const [zyMaxText, setZyMaxText] = useState(settings.strikeZone ? String(settings.strikeZone.yMax) : '');

  const onTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    const ok = await checkHealth(settings.backendUrl);
    setTestResult(ok);
    setTesting(false);
  };

  const isOffline = settings.analysisMode === 'offline';

  const commitStrikeZone = () => {
    const values = [zxMinText, zxMaxText, zyMinText, zyMaxText];
    if (values.every((v) => v.trim() === '')) {
      updateSettings({ strikeZone: null });
      return;
    }

    const xMin = parseFloat(zxMinText);
    const xMax = parseFloat(zxMaxText);
    const yMin = parseFloat(zyMinText);
    const yMax = parseFloat(zyMaxText);
    const ok = [xMin, xMax, yMin, yMax].every(Number.isFinite)
      && xMin >= 0 && xMin < xMax && xMax <= 1
      && yMin >= 0 && yMin < yMax && yMax <= 1;
    if (!ok) return;

    updateSettings({ strikeZone: { xMin, xMax, yMin, yMax } });
  };

  const resetStrikeZone = () => {
    setZxMinText('');
    setZxMaxText('');
    setZyMinText('');
    setZyMaxText('');
    updateSettings({ strikeZone: null });
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        {/* Analysis Mode */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Analysis Mode</Text>
          <View style={styles.modeRow}>
            <TouchableOpacity
              style={[styles.modeBtn, isOffline && styles.modeBtnActive]}
              onPress={() => updateSettings({ analysisMode: 'offline' as AnalysisMode })}
              activeOpacity={0.7}
            >
              <Text style={styles.modeBtnIcon}>📱</Text>
              <Text style={[styles.modeBtnLabel, isOffline && styles.modeBtnLabelActive]}>
                離線模式
              </Text>
              <Text style={styles.modeBtnDesc}>裝置端 AI 運算</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.modeBtn, !isOffline && styles.modeBtnActive]}
              onPress={() => updateSettings({ analysisMode: 'online' as AnalysisMode })}
              activeOpacity={0.7}
            >
              <Text style={styles.modeBtnIcon}>☁️</Text>
              <Text style={[styles.modeBtnLabel, !isOffline && styles.modeBtnLabelActive]}>
                線上模式
              </Text>
              <Text style={styles.modeBtnDesc}>上傳至伺服器</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.modeHint}>
            {isOffline
              ? '使用裝置內建 AI 分析，完全離線、不需要網路連線。'
              : '將影片上傳至後端伺服器分析，需要網路連線。'}
          </Text>
        </View>

        {/* Backend URL — only show in online mode */}
        {!isOffline && (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Server Connection</Text>

            <View style={styles.field}>
              <Text style={styles.label}>Backend URL</Text>
              <TextInput
                style={styles.input}
                value={settings.backendUrl}
                onChangeText={(v) => updateSettings({ backendUrl: v })}
                placeholder="http://localhost:8000"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
              />
              <Text style={styles.hint}>
                Simulator: http://localhost:8000{'\n'}
                Physical device: use your Mac's LAN IP or ngrok URL
              </Text>
            </View>

            <TouchableOpacity
              style={styles.testBtn}
              onPress={onTestConnection}
              disabled={testing}
              activeOpacity={0.7}
            >
              {testing ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.testBtnText}>Test Connection</Text>
              )}
            </TouchableOpacity>
            {testResult !== null && (
              <Text style={[styles.testResult, { color: testResult ? Colors.green : Colors.red }]}>
                {testResult ? '✓ Connected successfully' : '✗ Connection failed'}
              </Text>
            )}
          </View>
        )}

        {/* Analysis Parameters */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Analysis Parameters</Text>

          <View style={styles.field}>
            <Text style={styles.label}>投打距離 Pitcher→Home Plate (m)</Text>
            <TextInput
              style={styles.input}
              value={moundText}
              onChangeText={setMoundText}
              onBlur={() => {
                const n = parseFloat(moundText);
                const val = isNaN(n) || n < 0 ? 0 : n;
                setMoundText(val > 0 ? String(val) : '');
                updateSettings({ moundDistanceM: val });
              }}
              keyboardType="decimal-pad"
              placeholder="請量測實際距離 (例如 7.0)"
              placeholderTextColor={Colors.textMuted}
            />
            <Text style={styles.hint}>
              ⚠️ 此數值直接影響球速準度。請務必自行量測。{'\n'}
              MLB 18.44 m · 高中 ~16 m · 少棒 ~14 m · 後院練投 5–10 m{'\n'}
              留空 = 自動從 pose 估算（準度較低，建議手動輸入）
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>投手身高 Pitcher Height (m, 選填)</Text>
            <TextInput
              style={styles.input}
              value={pitcherHeightText}
              onChangeText={setPitcherHeightText}
              onBlur={() => {
                const n = parseFloat(pitcherHeightText);
                if (!isNaN(n) && n > 1 && n < 2.4) {
                  setPitcherHeightText(String(n));
                  updateSettings({ pitcherHeightM: n });
                } else {
                  setPitcherHeightText('');
                  updateSettings({ pitcherHeightM: undefined });
                }
              }}
              keyboardType="decimal-pad"
              placeholder="例如 1.75"
              placeholderTextColor={Colors.textMuted}
            />
            <Text style={styles.hint}>
              若留空會用肩寬估距；填入身高時改用全身高，對側身姿勢更穩。
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Stride Correction (metres)</Text>
            <TextInput
              style={styles.input}
              value={strideText}
              onChangeText={setStrideText}
              onBlur={() => {
                const n = parseFloat(strideText);
                const val = isNaN(n) ? 0 : n;
                setStrideText(String(val));
                updateSettings({ strideCorrectionM: val });
              }}
              keyboardType="decimal-pad"
              placeholderTextColor={Colors.textMuted}
            />
            <Text style={styles.hint}>
              投手跨步距離（公尺），從投球距離中扣除以提升準確度，不確定請填 0
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Detection Confidence Threshold</Text>
            <TextInput
              style={styles.input}
              value={confText}
              onChangeText={setConfText}
              onBlur={() => {
                const n = parseFloat(confText);
                const val = isNaN(n) || n <= 0 ? 0.03 : n;
                setConfText(String(val));
                updateSettings({ confThreshold: val });
              }}
              keyboardType="decimal-pad"
              placeholderTextColor={Colors.textMuted}
            />
            <Text style={styles.hint}>
              Lower = more detections but more noise. Recommended: 0.03–0.10.
            </Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Strike Zone Calibration</Text>
          <Text style={styles.hint}>
            主審視角框線座標，0–1 代表影片畫面比例。預設 x 0.33–0.67，y 0.56–0.86。
          </Text>
          <View style={styles.zoneGrid}>
            <View style={styles.zoneField}>
              <Text style={styles.label}>x_min</Text>
              <TextInput
                style={styles.input}
                value={zxMinText}
                onChangeText={setZxMinText}
                onBlur={commitStrikeZone}
                keyboardType="decimal-pad"
                placeholder="0.33"
                placeholderTextColor={Colors.textMuted}
              />
            </View>
            <View style={styles.zoneField}>
              <Text style={styles.label}>x_max</Text>
              <TextInput
                style={styles.input}
                value={zxMaxText}
                onChangeText={setZxMaxText}
                onBlur={commitStrikeZone}
                keyboardType="decimal-pad"
                placeholder="0.67"
                placeholderTextColor={Colors.textMuted}
              />
            </View>
            <View style={styles.zoneField}>
              <Text style={styles.label}>y_min</Text>
              <TextInput
                style={styles.input}
                value={zyMinText}
                onChangeText={setZyMinText}
                onBlur={commitStrikeZone}
                keyboardType="decimal-pad"
                placeholder="0.56"
                placeholderTextColor={Colors.textMuted}
              />
            </View>
            <View style={styles.zoneField}>
              <Text style={styles.label}>y_max</Text>
              <TextInput
                style={styles.input}
                value={zyMaxText}
                onChangeText={setZyMaxText}
                onBlur={commitStrikeZone}
                keyboardType="decimal-pad"
                placeholder="0.86"
                placeholderTextColor={Colors.textMuted}
              />
            </View>
          </View>
          <TouchableOpacity style={styles.secondaryBtn} onPress={resetStrikeZone} activeOpacity={0.7}>
            <Text style={styles.secondaryBtnText}>重置為預設</Text>
          </TouchableOpacity>
          {settings.strikeZone && (
            <Text style={[styles.hint, { color: Colors.green }]}>
              已套用：x {settings.strikeZone.xMin}–{settings.strikeZone.xMax}，
              y {settings.strikeZone.yMin}–{settings.strikeZone.yMax}
            </Text>
          )}
        </View>

        {/* About */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>About</Text>
          <Text style={styles.aboutText}>
            <Text style={{ color: Colors.text, fontWeight: '700' }}>SpeedGun</Text>
            {'\n'}AI-powered baseball pitch speed analyser.
            {'\n'}
            {isOffline
              ? 'Select a video → on-device AI analysis → instant speed readout.'
              : 'Upload a video → get instant mph / km/h readout.'}
            {'\n\n'}Powered by YOLO ball detection, body pose estimation, and a physics-based speed calculator.
          </Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  content: {
    paddingBottom: 40,
  },
  card: {
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
  sectionTitle: {
    fontSize: 14,
    color: Colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginBottom: 16,
    fontWeight: '600',
  },
  modeRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  modeBtn: {
    flex: 1,
    borderWidth: 2,
    borderColor: Colors.border,
    borderRadius: 12,
    padding: 14,
    alignItems: 'center',
    gap: 4,
  },
  modeBtnActive: {
    borderColor: Colors.accent,
    backgroundColor: Colors.accent + '0D',
  },
  modeBtnIcon: {
    fontSize: 24,
    marginBottom: 4,
  },
  modeBtnLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.textMuted,
  },
  modeBtnLabelActive: {
    color: Colors.accent,
  },
  modeBtnDesc: {
    fontSize: 11,
    color: Colors.textMuted,
    textAlign: 'center',
    lineHeight: 15,
  },
  modeHint: {
    fontSize: 12,
    color: Colors.textMuted,
    lineHeight: 18,
    textAlign: 'center',
  },
  field: {
    marginBottom: 18,
  },
  zoneGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 12,
  },
  zoneField: {
    width: '47%',
  },
  label: {
    fontSize: 13,
    color: Colors.textMuted,
    marginBottom: 6,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  input: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    color: Colors.text,
    fontSize: 16,
    padding: 12,
    paddingHorizontal: 14,
  },
  hint: {
    fontSize: 12,
    color: Colors.textMuted,
    marginTop: 4,
    lineHeight: 18,
  },
  testBtn: {
    backgroundColor: Colors.accent,
    borderRadius: 10,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  testBtnText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  testResult: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 8,
  },
  secondaryBtn: {
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: 10,
    height: 42,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 12,
  },
  secondaryBtnText: {
    color: Colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  aboutText: {
    fontSize: 14,
    color: Colors.textMuted,
    lineHeight: 24,
  },
});
