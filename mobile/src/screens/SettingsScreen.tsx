import React, { useState } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity,
  KeyboardAvoidingView, Platform, ActivityIndicator, StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, Radius, Shadows, Spacing, TouchTarget } from '../theme';
import { useSettings } from '../context/SettingsContext';
import { checkHealth } from '../api';
import type { AnalysisMode } from '../types';
import SegmentedTabs from '../components/SegmentedTabs';

const BASIC_TAB = '基本';
const ADVANCED_TAB = '進階';
const SETTINGS_TABS = [BASIC_TAB, ADVANCED_TAB];

const MOUND_PRESETS = [5, 7, 14, 18.44];
const STRIDE_PRESETS = [0, 1.5, 1.8];
const CONF_PRESETS = ['0.03', '0.05', '0.10'];

export default function SettingsScreen() {
  const { settings, updateSettings } = useSettings();
  const [activeTab, setActiveTab] = useState(BASIC_TAB);
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

  const isOffline = settings.analysisMode === 'offline';

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
          : { ok: false, ms, msg: '伺服器無回應或回傳錯誤狀態' },
      );
    } catch {
      setTestResult({ ok: false, ms: Date.now() - t0, msg: '連線失敗，請檢查 URL 與網路' });
    } finally {
      setTesting(false);
    }
  };

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

  const modeOptions: Array<{
    key: AnalysisMode;
    title: string;
    desc: string;
    icon: keyof typeof Ionicons.glyphMap;
  }> = [
    { key: 'offline', title: '離線模式', desc: '裝置端 AI', icon: 'phone-portrait-outline' },
    { key: 'online', title: '線上模式', desc: '後端運算', icon: 'cloud-outline' },
  ];

  return (
    <KeyboardAvoidingView
      style={styles.root}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.headerCard}>
          <View style={styles.headerIcon}>
            <Ionicons name="options-outline" size={24} color={Colors.accent} />
          </View>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>SETTINGS</Text>
            <Text style={styles.headerTitle}>分析設定</Text>
            <Text style={styles.headerSub}>
              {isOffline ? '目前使用裝置端分析' : '目前使用伺服器分析'}
            </Text>
          </View>
        </View>

        <SegmentedTabs
          tabs={SETTINGS_TABS}
          activeTab={activeTab}
          onSelect={setActiveTab}
          containerStyle={styles.tabs}
        />

        {activeTab === BASIC_TAB ? (
          <>
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View>
                  <Text style={styles.sectionTitle}>分析模式</Text>
                  <Text style={styles.sectionSub}>{isOffline ? '免網路，適合現場練習' : '適合使用遠端算力'}</Text>
                </View>
                <View style={styles.statusPill}>
                  <View style={[styles.statusDot, { backgroundColor: isOffline ? Colors.green : Colors.accent }]} />
                  <Text style={styles.statusPillText}>{isOffline ? '離線' : '線上'}</Text>
                </View>
              </View>
              <View style={styles.modeRow}>
                {modeOptions.map((option) => {
                  const selected = settings.analysisMode === option.key;
                  return (
                    <TouchableOpacity
                      key={option.key}
                      style={[styles.modeBtn, selected && styles.modeBtnActive]}
                      onPress={() => updateSettings({ analysisMode: option.key })}
                      activeOpacity={0.75}
                      accessibilityRole="radio"
                      accessibilityState={{ selected }}
                      accessibilityLabel={`${option.title}，${option.desc}`}
                    >
                      <View style={[styles.modeIcon, selected && styles.modeIconActive]}>
                        <Ionicons
                          name={option.icon}
                          size={20}
                          color={selected ? '#fff' : Colors.textMuted}
                        />
                      </View>
                      <Text style={[styles.modeBtnLabel, selected && styles.modeBtnLabelActive]}>
                        {option.title}
                      </Text>
                      <Text style={styles.modeBtnDesc}>{option.desc}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            {!isOffline && (
              <View style={styles.card}>
                <View style={styles.cardHeader}>
                  <View>
                    <Text style={styles.sectionTitle}>伺服器連線</Text>
                    <Text style={styles.sectionSub}>Backend URL</Text>
                  </View>
                  <Ionicons name="server-outline" size={20} color={Colors.textMuted} />
                </View>
                <View style={styles.field}>
                  <TextInput
                    style={styles.input}
                    value={settings.backendUrl}
                    onChangeText={(v) => {
                      updateSettings({ backendUrl: v });
                      if (testResult) setTestResult(null);
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
                </View>
                <TouchableOpacity
                  style={[styles.primaryBtn, (!settings.backendUrl.trim() || testing) && styles.btnDisabled]}
                  onPress={onTestConnection}
                  disabled={testing || !settings.backendUrl.trim()}
                  activeOpacity={0.75}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: testing || !settings.backendUrl.trim(), busy: testing }}
                  accessibilityLabel="測試後端伺服器連線"
                >
                  {testing ? (
                    <View style={styles.btnInner}>
                      <ActivityIndicator size="small" color="#fff" />
                      <Text style={styles.primaryBtnText}>測試中…</Text>
                    </View>
                  ) : (
                    <View style={styles.btnInner}>
                      <Ionicons name="pulse-outline" size={18} color="#fff" />
                      <Text style={styles.primaryBtnText}>測試連線</Text>
                    </View>
                  )}
                </TouchableOpacity>
                {testResult !== null && (
                  <View style={[styles.resultBanner, testResult.ok ? styles.resultGood : styles.resultBad]}>
                    <Ionicons
                      name={testResult.ok ? 'checkmark-circle-outline' : 'alert-circle-outline'}
                      size={18}
                      color={testResult.ok ? Colors.green : Colors.red}
                    />
                    <Text style={[styles.resultText, { color: testResult.ok ? Colors.green : Colors.red }]}>
                      {testResult.msg}
                    </Text>
                  </View>
                )}
              </View>
            )}

            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View>
                  <Text style={styles.sectionTitle}>量測資料</Text>
                  <Text style={styles.sectionSub}>影響球速與距離估算</Text>
                </View>
                <Ionicons name="analytics-outline" size={20} color={Colors.textMuted} />
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>投打距離</Text>
                <View style={styles.inputWithUnit}>
                  <TextInput
                    style={styles.unitInput}
                    value={moundText}
                    onChangeText={setMoundText}
                    onBlur={() => {
                      const n = parseFloat(moundText);
                      const val = isNaN(n) || n < 0 ? 0 : n;
                      setMoundText(val > 0 ? String(val) : '');
                      updateSettings({ moundDistanceM: val });
                    }}
                    keyboardType="decimal-pad"
                    placeholder="例如 7.0"
                    placeholderTextColor={Colors.textMuted}
                    returnKeyType="done"
                    accessibilityLabel="投打距離，公尺"
                  />
                  <Text style={styles.unitText}>m</Text>
                </View>
                <View style={styles.quickRow}>
                  {MOUND_PRESETS.map((value) => {
                    const selected = Number(moundText) === value;
                    return (
                      <TouchableOpacity
                        key={value}
                        style={[styles.quickChip, selected && styles.quickChipActive]}
                        onPress={() => {
                          setMoundText(String(value));
                          updateSettings({ moundDistanceM: value });
                        }}
                        activeOpacity={0.75}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        accessibilityLabel={`投打距離 ${value} 公尺`}
                      >
                        <Text style={[styles.quickChipText, selected && styles.quickChipTextActive]}>
                          {value}m
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <Text style={styles.hint}>留空會自動估算；手動量測通常更穩。</Text>
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>投手身高</Text>
                <View style={styles.inputWithUnit}>
                  <TextInput
                    style={styles.unitInput}
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
                    placeholder="選填，例如 1.75"
                    placeholderTextColor={Colors.textMuted}
                    returnKeyType="done"
                    accessibilityLabel="投手身高，公尺，可選"
                  />
                  <Text style={styles.unitText}>m</Text>
                </View>
              </View>

              <View style={[styles.field, styles.fieldLast]}>
                <Text style={styles.label}>跨步補償</Text>
                <View style={styles.inputWithUnit}>
                  <TextInput
                    style={styles.unitInput}
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
                    accessibilityLabel="跨步補償距離，公尺"
                  />
                  <Text style={styles.unitText}>m</Text>
                </View>
                <View style={styles.quickRow}>
                  {STRIDE_PRESETS.map((value) => {
                    const selected = Number(strideText) === value;
                    return (
                      <TouchableOpacity
                        key={value}
                        style={[styles.quickChip, selected && styles.quickChipActive]}
                        onPress={() => {
                          setStrideText(String(value));
                          updateSettings({ strideCorrectionM: value });
                        }}
                        activeOpacity={0.75}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        accessibilityLabel={`跨步補償 ${value} 公尺`}
                      >
                        <Text style={[styles.quickChipText, selected && styles.quickChipTextActive]}>
                          {value}m
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>
            </View>
          </>
        ) : (
          <>
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View>
                  <Text style={styles.sectionTitle}>偵測精度</Text>
                  <Text style={styles.sectionSub}>YOLO confidence threshold</Text>
                </View>
                <View style={styles.valuePill}>
                  <Text style={styles.valuePillText}>{settings.confThreshold}</Text>
                </View>
              </View>
              <View style={[styles.field, styles.fieldLast]}>
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
                  accessibilityLabel="偵測信心閾值"
                />
                <View style={styles.quickRow}>
                  {CONF_PRESETS.map((value) => {
                    const selected = confText === value;
                    return (
                      <TouchableOpacity
                        key={value}
                        style={[styles.quickChip, selected && styles.quickChipActive]}
                        onPress={() => {
                          setConfText(value);
                          updateSettings({ confThreshold: Number(value) });
                        }}
                        activeOpacity={0.75}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        accessibilityLabel={`偵測信心閾值 ${value}`}
                      >
                        <Text style={[styles.quickChipText, selected && styles.quickChipTextActive]}>
                          {value}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <Text style={styles.hint}>較低會抓到更多候選球點，較高會減少雜訊。</Text>
              </View>
            </View>

            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View>
                  <Text style={styles.sectionTitle}>好球帶校正</Text>
                  <Text style={styles.sectionSub}>主審視角畫面比例 0-1</Text>
                </View>
                <Ionicons name="grid-outline" size={20} color={Colors.textMuted} />
              </View>
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
                activeOpacity={0.75}
                accessibilityRole="button"
                accessibilityLabel="重置好球帶為預設值"
              >
                <Ionicons name="refresh-outline" size={17} color={Colors.text} />
                <Text style={styles.secondaryBtnText}>重置為預設</Text>
              </TouchableOpacity>
              {settings.strikeZone && (
                <View style={styles.zoneApplied}>
                  <Ionicons name="checkmark-circle-outline" size={17} color={Colors.green} />
                  <Text style={styles.zoneAppliedText}>
                    x {settings.strikeZone.xMin}-{settings.strikeZone.xMax} / y {settings.strikeZone.yMin}-{settings.strikeZone.yMax}
                  </Text>
                </View>
              )}
            </View>

            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View>
                  <Text style={styles.sectionTitle}>關於</Text>
                  <Text style={styles.sectionSub}>SpeedGun</Text>
                </View>
                <Ionicons name="information-circle-outline" size={20} color={Colors.textMuted} />
              </View>
              <Text style={styles.aboutText}>
                AI 棒球球速與球路分析工具，整合 YOLO 棒球偵測、姿勢估測與物理模型。
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  scroll: {
    flex: 1,
    backgroundColor: Colors.bg,
  },
  content: {
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    paddingBottom: 48,
  },
  headerCard: {
    minHeight: 96,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.xxl,
    padding: Spacing.lg,
    ...Shadows.soft,
  },
  headerIcon: {
    width: 52,
    height: 52,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(14,165,233,0.10)',
    borderWidth: 1,
    borderColor: 'rgba(14,165,233,0.22)',
  },
  headerCopy: {
    flex: 1,
    minWidth: 0,
  },
  eyebrow: {
    color: Colors.textMuted,
    fontSize: FontSize.xs,
    fontWeight: '900',
    letterSpacing: 0.8,
    marginBottom: 3,
  },
  headerTitle: {
    color: Colors.text,
    fontSize: 24,
    fontWeight: '900',
    letterSpacing: 0,
  },
  headerSub: {
    color: Colors.textMuted,
    fontSize: FontSize.sm,
    marginTop: 4,
  },
  tabs: {
    marginHorizontal: 0,
    marginTop: Spacing.md,
    marginBottom: 0,
  },
  card: {
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.xl,
    padding: Spacing.lg,
    marginTop: Spacing.md,
    ...Shadows.soft,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: Spacing.md,
    marginBottom: Spacing.md,
  },
  sectionTitle: {
    fontSize: FontSize.lg,
    color: Colors.text,
    fontWeight: '900',
  },
  sectionSub: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    marginTop: 2,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 32,
    borderRadius: 999,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 10,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusPillText: {
    color: Colors.text,
    fontSize: FontSize.xs,
    fontWeight: '900',
  },
  modeRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  modeBtn: {
    flex: 1,
    minHeight: 118,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface2,
    padding: Spacing.md,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 6,
  },
  modeBtnActive: {
    borderColor: Colors.accent,
    backgroundColor: 'rgba(14,165,233,0.08)',
  },
  modeIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    marginBottom: 2,
  },
  modeIconActive: {
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
  },
  modeBtnLabel: {
    fontSize: FontSize.md,
    fontWeight: '900',
    color: Colors.text,
    textAlign: 'center',
  },
  modeBtnLabelActive: {
    color: Colors.accent,
  },
  modeBtnDesc: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  field: {
    marginBottom: Spacing.lg,
  },
  fieldLast: {
    marginBottom: 0,
  },
  label: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    marginBottom: Spacing.xs,
    fontWeight: '800',
  },
  input: {
    minHeight: TouchTarget.min,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.lg,
    color: Colors.text,
    fontSize: FontSize.md,
    fontWeight: '700',
    paddingVertical: 10,
    paddingHorizontal: Spacing.md,
  },
  inputWithUnit: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing.md,
  },
  unitInput: {
    flex: 1,
    minWidth: 0,
    color: Colors.text,
    fontSize: FontSize.lg,
    fontWeight: '800',
    paddingVertical: 0,
    fontVariant: ['tabular-nums'],
  },
  unitText: {
    color: Colors.textMuted,
    fontSize: FontSize.sm,
    fontWeight: '900',
  },
  quickRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
  },
  quickChip: {
    minHeight: TouchTarget.min,
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md,
  },
  quickChipActive: {
    borderColor: Colors.accent,
    backgroundColor: 'rgba(14,165,233,0.10)',
  },
  quickChipText: {
    color: Colors.textMuted,
    fontSize: FontSize.sm,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  quickChipTextActive: {
    color: Colors.accent,
  },
  hint: {
    fontSize: FontSize.sm,
    color: Colors.textMuted,
    marginTop: Spacing.sm,
    lineHeight: 18,
  },
  primaryBtn: {
    minHeight: TouchTarget.min,
    backgroundColor: Colors.accent,
    borderRadius: Radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled: {
    opacity: 0.5,
  },
  btnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: FontSize.md,
    fontWeight: '800',
  },
  resultBanner: {
    minHeight: 42,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderRadius: Radius.lg,
    borderWidth: 1,
    paddingHorizontal: Spacing.md,
    marginTop: Spacing.md,
  },
  resultGood: {
    backgroundColor: 'rgba(16,185,129,0.08)',
    borderColor: 'rgba(16,185,129,0.24)',
  },
  resultBad: {
    backgroundColor: 'rgba(239,68,68,0.08)',
    borderColor: 'rgba(239,68,68,0.24)',
  },
  resultText: {
    flex: 1,
    fontSize: FontSize.sm,
    fontWeight: '800',
  },
  valuePill: {
    minHeight: 34,
    minWidth: 62,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(14,165,233,0.24)',
    backgroundColor: 'rgba(14,165,233,0.10)',
    paddingHorizontal: Spacing.md,
  },
  valuePillText: {
    color: Colors.accent,
    fontSize: FontSize.sm,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  zoneGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
  },
  zoneField: {
    flexBasis: '47%',
    flexGrow: 1,
  },
  secondaryBtn: {
    minHeight: TouchTarget.min,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface2,
    marginTop: Spacing.md,
  },
  secondaryBtnText: {
    color: Colors.text,
    fontSize: FontSize.md,
    fontWeight: '800',
  },
  zoneApplied: {
    minHeight: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    borderRadius: Radius.lg,
    backgroundColor: 'rgba(16,185,129,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(16,185,129,0.24)',
    paddingHorizontal: Spacing.md,
    marginTop: Spacing.md,
  },
  zoneAppliedText: {
    flex: 1,
    color: Colors.green,
    fontSize: FontSize.sm,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  aboutText: {
    fontSize: FontSize.md,
    color: Colors.textMuted,
    lineHeight: 22,
  },
});
