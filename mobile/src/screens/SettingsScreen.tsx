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
  const [testResult, setTestResult] = useState<{ ok: boolean; ms: number; msg: string } | null>(null);

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
    const url = settings.backendUrl.trim();
    if (!url) {
      setTestResult({ ok: false, ms: 0, msg: '請先輸入 Backend URL' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    const t0 = Date.now();
    try {
      const ok = await checkHealth(url);
      const ms = Date.now() - t0;
      setTestResult(
        ok
          ? { ok: true, ms, msg: `連線成功（${ms} ms）` }
          : { ok: false, ms, msg: `伺服器無回應或回傳錯誤狀態` },
      );
    } catch {
      setTestResult({ ok: false, ms: Date.now() - t0, msg: '連線失敗，請檢查 URL 與網路' });
    } finally {
      setTesting(false);
    }
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
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {/* Analysis Mode */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>分析模式</Text>
          <View style={styles.modeRow}>
            <TouchableOpacity
              style={[styles.modeBtn, isOffline && styles.modeBtnActive]}
              onPress={() => updateSettings({ analysisMode: 'offline' as AnalysisMode })}
              activeOpacity={0.7}
              accessibilityRole="radio"
              accessibilityState={{ selected: isOffline }}
              accessibilityLabel="離線模式，裝置端 AI 運算"
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
              accessibilityRole="radio"
              accessibilityState={{ selected: !isOffline }}
              accessibilityLabel="線上模式，上傳到伺服器運算"
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
            <Text style={styles.sectionTitle}>伺服器連線</Text>

            <View style={styles.field}>
              <Text style={styles.label}>Backend URL</Text>
              <TextInput
                style={styles.input}
                value={settings.backendUrl}
                onChangeText={(v) => {
                  updateSettings({ backendUrl: v });
                  if (testResult) setTestResult(null);  // invalidate stale result
                }}
                placeholder="https://your-server.example.com"
                placeholderTextColor={Colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                returnKeyType="done"
                clearButtonMode="while-editing"
                accessibilityLabel="後端伺服器網址"
              />
              <Text style={styles.hint}>
                需要 backend 服務時才需要填寫；如果你只想用裝置端 AI，請改回離線模式。{'\n'}
                範例：自架 server (https://...) 或 ngrok / Tailscale 隧道網址。
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.testBtn, (!settings.backendUrl.trim() || testing) && { opacity: 0.5 }]}
              onPress={onTestConnection}
              disabled={testing || !settings.backendUrl.trim()}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityState={{ disabled: testing || !settings.backendUrl.trim(), busy: testing }}
              accessibilityLabel="測試後端伺服器連線"
            >
              {testing ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <ActivityIndicator size="small" color="#fff" />
                  <Text style={styles.testBtnText}>測試中…</Text>
                </View>
              ) : (
                <Text style={styles.testBtnText}>測試連線</Text>
              )}
            </TouchableOpacity>
            {testResult !== null && (
              <Text style={[styles.testResult, { color: testResult.ok ? Colors.green : Colors.red }]}>
                {testResult.ok ? '✓ ' : '✗ '}{testResult.msg}
              </Text>
            )}
          </View>
        )}

        {/* Analysis Parameters */}
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>分析參數</Text>

          <View style={styles.field}>
            <Text style={styles.label}>投打距離 (公尺)</Text>
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
              returnKeyType="done"
              accessibilityLabel="投打距離（公尺），影響球速計算準度"
            />
            <Text style={styles.hint}>
              ⚠️ 此數值直接影響球速準度。請務必自行量測。{'\n'}
              MLB 18.44 m · 高中 ~16 m · 少棒 ~14 m · 後院練投 5–10 m{'\n'}
              留空 = 自動從 pose 估算（準度較低，建議手動輸入）
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>投手身高 (公尺，選填)</Text>
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
              returnKeyType="done"
              accessibilityLabel="投手身高（公尺），可選"
            />
            <Text style={styles.hint}>
              若留空會用肩寬估距；填入身高時改用全身高，對側身姿勢更穩。
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>跨步補償距離 (公尺)</Text>
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
              placeholder="例如 1.7"
              placeholderTextColor={Colors.textMuted}
              returnKeyType="done"
              accessibilityLabel="跨步補償（公尺）"
            />
            <Text style={styles.hint}>
              投手跨步距離（公尺），從投球距離中扣除以提升準確度，不確定請填 0
            </Text>
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>偵測信心閾值</Text>
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
              placeholder="0.03"
              placeholderTextColor={Colors.textMuted}
              returnKeyType="done"
              accessibilityLabel="偵測信心閾值，數值越小偵測越多"
            />
            <Text style={styles.hint}>
              數值越小 = 偵測到的球越多，但雜訊也較高。建議 0.03–0.10。
            </Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>好球帶校正</Text>
          <Text style={styles.hint}>
            主審視角框線座標，0–1 代表影片畫面比例。預設 x 0.33–0.67，y 0.56–0.86。
          </Text>
          <View style={styles.zoneGrid}>
            {([
              ['x_min', zxMinText, setZxMinText, '0.33', '好球帶左邊界'],
              ['x_max', zxMaxText, setZxMaxText, '0.67', '好球帶右邊界'],
              ['y_min', zyMinText, setZyMinText, '0.56', '好球帶上邊界'],
              ['y_max', zyMaxText, setZyMaxText, '0.86', '好球帶下邊界'],
            ] as const).map(([label, value, setter, placeholder, a11y]) => (
              <View key={label} style={styles.zoneField}>
                <Text style={styles.label}>{label}</Text>
                <TextInput
                  style={styles.input}
                  value={value}
                  onChangeText={setter}
                  onBlur={commitStrikeZone}
                  keyboardType="decimal-pad"
                  placeholder={placeholder}
                  placeholderTextColor={Colors.textMuted}
                  returnKeyType="done"
                  accessibilityLabel={a11y}
                />
              </View>
            ))}
          </View>
          <TouchableOpacity
            style={styles.secondaryBtn}
            onPress={resetStrikeZone}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="重置好球帶為預設值"
          >
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
          <Text style={styles.sectionTitle}>關於</Text>
          <Text style={styles.aboutText}>
            <Text style={{ color: Colors.text, fontWeight: '700' }}>SpeedGun</Text>
            {'\n'}AI 棒球球速與球路分析工具。
            {'\n\n'}
            {isOffline
              ? '選擇影片 → 裝置端 AI 分析 → 即時取得球速與位移資料。'
              : '上傳影片 → 伺服器分析 → 即時取得 mph / km/h 球速。'}
            {'\n\n'}採用 YOLO 棒球偵測、身體姿勢估測，以及物理模型球速計算。
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
