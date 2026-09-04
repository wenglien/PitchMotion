import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity,
  KeyboardAvoidingView, Linking, Platform, StyleSheet, Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Colors, FontSize, Radius, Shadows, Spacing, Surfaces, TouchTarget } from '../theme';
import { useSettings } from '../context/SettingsContext';
import {
  isManualDistanceCalibrated,
  MAX_MANUAL_MOUND_DISTANCE_M,
  MIN_MANUAL_MOUND_DISTANCE_M,
  StrikeZoneCalibration,
} from '../types';
import SegmentedTabs from '../components/SegmentedTabs';
import StrikeZoneCalibrator from '../components/StrikeZoneCalibrator';

const BASIC_TAB = '基本';
const ADVANCED_TAB = '進階';
const SETTINGS_TABS = [BASIC_TAB, ADVANCED_TAB];

const MOUND_PRESETS = [5, 7, 14, 18.44];
const STRIDE_PRESETS = [0, 1.5, 1.8];
const PRIVACY_URL = 'https://github.com/wenglien/Baseball-Trajectory-Analysis/blob/main/docs/privacy-policy.md';
const SUPPORT_URL = 'https://github.com/wenglien/Baseball-Trajectory-Analysis/issues';
const BACKGROUND_CREDIT_URL = 'https://commons.wikimedia.org/wiki/File:FldofDrmsPtcrMound051904.jpg';
const DEFAULT_ZONE: StrikeZoneCalibration = { xMin: 0.33, xMax: 0.67, yMin: 0.56, yMax: 0.86 };
const DETECTION_MODES = [
  { label: '靈敏', value: '0.03', description: '弱光或球較小' },
  { label: '平衡', value: '0.05', description: '一般拍攝建議' },
  { label: '穩定', value: '0.10', description: '減少背景雜訊' },
] as const;

export default function SettingsScreen() {
  const { settings, updateSettings } = useSettings();
  const [activeTab, setActiveTab] = useState(BASIC_TAB);
  const [showNumericZone, setShowNumericZone] = useState(false);

  // Local string state so decimal-point mid-input isn't swallowed by parseFloat
  const [moundText, setMoundText] = useState(
    settings.moundDistanceM > 0 ? String(settings.moundDistanceM) : '',
  );
  const [moundTouched, setMoundTouched] = useState(false);
  const [strideText, setStrideText] = useState(String(settings.strideCorrectionM));
  const [confText, setConfText] = useState(String(settings.confThreshold));
  const [zxMinText, setZxMinText] = useState(settings.strikeZone ? String(settings.strikeZone.xMin) : '');
  const [zxMaxText, setZxMaxText] = useState(settings.strikeZone ? String(settings.strikeZone.xMax) : '');
  const [zyMinText, setZyMinText] = useState(settings.strikeZone ? String(settings.strikeZone.yMin) : '');
  const [zyMaxText, setZyMaxText] = useState(settings.strikeZone ? String(settings.strikeZone.yMax) : '');

  useEffect(() => { setStrideText(String(settings.strideCorrectionM)); }, [settings.strideCorrectionM]);

  const hasDistanceCalibration = isManualDistanceCalibrated(settings.moundDistanceM);
  const moundInputValue = Number(moundText);
  const moundInputError = moundTouched
    && moundText.trim() !== ''
    && !isManualDistanceCalibrated(moundInputValue);

  const saveMoundDistance = (value: number) => {
    setMoundTouched(true);
    if (isManualDistanceCalibrated(value) && settings.strideCorrectionM > value - 1) {
      updateSettings({ moundDistanceM: 0 });
      Alert.alert('請先調整跨步補償', '補償後需保留至少 1 公尺的飛行距離，調整後請重新確認投打距離。');
      return;
    }
    if (isManualDistanceCalibrated(value)) {
      setMoundText(String(value));
      updateSettings({ moundDistanceM: value });
      return;
    }
    // Clearing or entering an invalid value explicitly invalidates the prior
    // calibration. Keeping an old distance would be much more dangerous.
    updateSettings({ moundDistanceM: 0 });
  };

  const commitStrikeZone = () => {
    const values = [zxMinText, zxMaxText, zyMinText, zyMaxText];
    if (values.every((v) => v.trim() === '')) {
      updateSettings({ strikeZone: null });
      return;
    }

    if (values.some((value) => value.trim() === '')) return;
    const [xMin, xMax, yMin, yMax] = values.map(Number);
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

  const applyVisualZone = (zone: StrikeZoneCalibration) => {
    setZxMinText(String(zone.xMin));
    setZxMaxText(String(zone.xMax));
    setZyMinText(String(zone.yMin));
    setZyMaxText(String(zone.yMax));
    updateSettings({ strikeZone: zone });
  };

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
            <Text style={styles.eyebrow}>設定</Text>
            <Text style={styles.headerTitle}>分析設定</Text>
            <Text style={styles.headerSub}>所有分析均在這台裝置完成</Text>
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
                  <Text style={styles.sectionTitle}>速度單位</Text>
                  <Text style={styles.sectionSub}>整個 App 會使用相同單位</Text>
                </View>
                <Ionicons name="speedometer-outline" size={20} color={Colors.textMuted} />
              </View>
              <View style={styles.unitChoiceRow}>
                {([
                  ['mph', '英里／小時', '美式球探常用'],
                  ['kmh', '公里／小時', '公制速度'],
                ] as const).map(([value, label, description]) => {
                  const selected = settings.speedUnit === value;
                  return (
                    <TouchableOpacity
                      key={value}
                      style={[styles.unitChoice, selected && styles.unitChoiceActive]}
                      onPress={() => updateSettings({ speedUnit: value })}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected }}
                    >
                      <Text style={[styles.unitChoiceValue, selected && styles.unitChoiceValueActive]}>
                        {value === 'mph' ? 'mph' : 'km/h'}
                      </Text>
                      <Text style={styles.unitChoiceLabel}>{label}</Text>
                      <Text style={styles.unitChoiceDescription}>{description}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View>
                  <Text style={styles.sectionTitle}>投打距離校正</Text>
                  <Text style={styles.sectionSub}>正式球速分析前必填</Text>
                </View>
                <View style={styles.calibrationStatus}>
                  <Ionicons
                    name={hasDistanceCalibration ? 'checkmark-circle-outline' : 'alert-circle-outline'}
                    size={17}
                    color={hasDistanceCalibration ? Colors.green : Colors.accent}
                  />
                  <Text style={[styles.calibrationStatusText, hasDistanceCalibration && styles.calibrationStatusTextDone]}>
                    {hasDistanceCalibration ? '已校正' : '待校正'}
                  </Text>
                </View>
              </View>

              <View style={styles.field}>
                <Text style={styles.label}>投手板前緣 → 本壘板後尖端</Text>
                <View style={[styles.inputWithUnit, moundInputError && styles.inputWithUnitError]}>
                  <TextInput
                    style={styles.unitInput}
                    value={moundText}
                    onChangeText={(value) => {
                      setMoundText(value);
                      setMoundTouched(true);
                      // Do not let a previously saved calibration remain valid
                      // while the user is replacing it with an incomplete value.
                      if (!isManualDistanceCalibrated(Number(value))) {
                        updateSettings({ moundDistanceM: 0 });
                      }
                    }}
                    onBlur={() => saveMoundDistance(Number(moundText))}
                    keyboardType="decimal-pad"
                    placeholder="例如 7.0"
                    placeholderTextColor={Colors.textMuted}
                    returnKeyType="done"
                    accessibilityLabel={`手動投打距離校正，公尺，需介於 ${MIN_MANUAL_MOUND_DISTANCE_M} 到 ${MAX_MANUAL_MOUND_DISTANCE_M} 公尺`}
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
                          setMoundTouched(true);
                          saveMoundDistance(value);
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
                <Text style={[styles.hint, moundInputError && styles.hintError]}>
                  {moundInputError
                    ? `請輸入 ${MIN_MANUAL_MOUND_DISTANCE_M}–${MAX_MANUAL_MOUND_DISTANCE_M}m 的量測值。`
                    : '請用捲尺量測固定場地距離；未填寫時 App 不會產生正式球速。'}
                </Text>
                <View style={styles.measurementGuide}>
                  <Ionicons name="information-circle-outline" size={17} color={Colors.textMuted} />
                  <Text style={styles.measurementGuideText}>
                    請量投手板前緣至本壘板後尖端。若跨步補償大於 0，系統會以「量測距離 − 跨步補償」作為有效飛行距離。
                  </Text>
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
                      const value = Number(strideText);
                      const maxStride = (settings.moundDistanceM || MAX_MANUAL_MOUND_DISTANCE_M) - 1;
                      if (!Number.isFinite(value) || value < 0 || value > maxStride) {
                        setStrideText(String(settings.strideCorrectionM));
                        Alert.alert('跨步補償無效', `請輸入 0–${maxStride} 公尺，並保留至少 1 公尺的有效飛行距離。`);
                        return;
                      }
                      setStrideText(String(value));
                      updateSettings({ strideCorrectionM: value });
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
                  <Text style={styles.sectionSub}>選擇適合拍攝環境的偵測方式</Text>
                </View>
                <View style={styles.valuePill}>
                  <Text style={styles.valuePillText}>{settings.confThreshold}</Text>
                </View>
              </View>
              <View style={[styles.field, styles.fieldLast]}>
                <Text style={styles.label}>偵測模式</Text>
                <View style={styles.detectionModeRow}>
                  {DETECTION_MODES.map((mode) => {
                    const selected = confText === mode.value;
                    return (
                      <TouchableOpacity
                        key={mode.value}
                        style={[styles.detectionMode, selected && styles.detectionModeActive]}
                        onPress={() => {
                          setConfText(mode.value);
                          updateSettings({ confThreshold: Number(mode.value) });
                        }}
                        activeOpacity={0.75}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        accessibilityLabel={`${mode.label}偵測模式，${mode.description}`}
                      >
                        <Ionicons
                          name={mode.label === '靈敏' ? 'flash-outline' : mode.label === '平衡' ? 'git-compare-outline' : 'shield-checkmark-outline'}
                          size={19}
                          color={selected ? Colors.accent : Colors.textMuted}
                        />
                        <Text style={[styles.detectionModeLabel, selected && styles.detectionModeLabelActive]}>
                          {mode.label}
                        </Text>
                        <Text style={styles.detectionModeDescription}>{mode.description}</Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <Text style={styles.hint}>目前設定值 {confText}。若不確定，建議使用「平衡」。</Text>
              </View>
            </View>

            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View>
                  <Text style={styles.sectionTitle}>好球帶校正</Text>
                  <Text style={styles.sectionSub}>直接在畫面上定位與調整大小</Text>
                </View>
                <Ionicons name="grid-outline" size={20} color={Colors.textMuted} />
              </View>
              <StrikeZoneCalibrator
                zone={settings.strikeZone ?? DEFAULT_ZONE}
                onChange={applyVisualZone}
              />
              <TouchableOpacity
                style={styles.numericToggle}
                onPress={() => setShowNumericZone((value) => !value)}
                accessibilityRole="button"
                accessibilityState={{ expanded: showNumericZone }}
              >
                <Text style={styles.numericToggleText}>{showNumericZone ? '隱藏精確數值' : '顯示精確數值'}</Text>
                <Ionicons name={showNumericZone ? 'chevron-up' : 'chevron-down'} size={16} color={Colors.textMuted} />
              </TouchableOpacity>
              {showNumericZone && (
                <View style={styles.zoneGrid}>
                  {([
                    ['左邊界', zxMinText, setZxMinText, '0.33', '好球帶左邊界'],
                    ['右邊界', zxMaxText, setZxMaxText, '0.67', '好球帶右邊界'],
                    ['上邊界', zyMinText, setZyMinText, '0.56', '好球帶上邊界'],
                    ['下邊界', zyMaxText, setZyMaxText, '0.86', '好球帶下邊界'],
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
              )}
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
                    已套用自訂好球帶
                  </Text>
                </View>
              )}
            </View>

            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View>
                  <Text style={styles.sectionTitle}>關於</Text>
                  <Text style={styles.sectionSub}>PitchMotion</Text>
                </View>
                <Ionicons name="information-circle-outline" size={20} color={Colors.textMuted} />
              </View>
              <Text style={styles.aboutText}>
                AI 棒球球速與球路分析工具。影片與分析資料只在裝置端處理，不會上傳伺服器。
              </Text>
              {([
                ['shield-checkmark-outline', '隱私權政策', PRIVACY_URL],
                ['help-circle-outline', '支援與問題回報', SUPPORT_URL],
                ['image-outline', '球場背景圖片授權', BACKGROUND_CREDIT_URL],
              ] as const).map(([icon, label, url]) => (
                <TouchableOpacity
                  key={label}
                  style={styles.secondaryBtn}
                  onPress={() => Linking.openURL(url)}
                  accessibilityRole="link"
                  accessibilityLabel={label}
                >
                  <Ionicons name={icon} size={17} color={Colors.text} />
                  <Text style={styles.secondaryBtnText}>{label}</Text>
                </TouchableOpacity>
              ))}
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
    ...Surfaces.card,
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
  unitChoiceRow: {
    flexDirection: 'row',
    gap: Spacing.sm,
  },
  unitChoice: {
    flex: 1,
    minHeight: 108,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface2,
    padding: Spacing.md,
  },
  unitChoiceActive: {
    borderColor: Colors.accent,
    backgroundColor: Colors.accentSubtle,
  },
  unitChoiceValue: {
    color: Colors.text,
    fontSize: FontSize.xxl,
    fontWeight: '900',
  },
  unitChoiceValueActive: { color: Colors.accent },
  unitChoiceLabel: {
    color: Colors.text,
    fontSize: FontSize.sm,
    fontWeight: '800',
    marginTop: 4,
  },
  unitChoiceDescription: {
    color: Colors.textMuted,
    fontSize: FontSize.xs,
    marginTop: 3,
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
  calibrationStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 30,
    borderRadius: 999,
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.border,
    paddingHorizontal: 9,
  },
  calibrationStatusText: {
    color: Colors.accent,
    fontSize: FontSize.xs,
    fontWeight: '900',
  },
  calibrationStatusTextDone: {
    color: Colors.green,
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
  inputWithUnitError: {
    borderColor: Colors.red,
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
  hintError: {
    color: Colors.red,
  },
  measurementGuide: {
    flexDirection: 'row',
    gap: Spacing.xs,
    marginTop: Spacing.md,
    padding: Spacing.sm,
    borderRadius: Radius.md,
    backgroundColor: Colors.surface2,
  },
  measurementGuideText: {
    flex: 1,
    color: Colors.textMuted,
    fontSize: FontSize.xs,
    lineHeight: 17,
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
  detectionModeRow: {
    flexDirection: 'row',
    gap: Spacing.xs,
  },
  detectionMode: {
    flex: 1,
    minHeight: 100,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface2,
    padding: Spacing.sm,
  },
  detectionModeActive: {
    borderColor: Colors.accent,
    backgroundColor: Colors.accentSubtle,
  },
  detectionModeLabel: {
    color: Colors.text,
    fontSize: FontSize.md,
    fontWeight: '900',
    marginTop: 6,
  },
  detectionModeLabelActive: { color: Colors.accent },
  detectionModeDescription: {
    color: Colors.textMuted,
    fontSize: FontSize.xs,
    lineHeight: 15,
    marginTop: 3,
    textAlign: 'center',
  },
  numericToggle: {
    minHeight: TouchTarget.min,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.xs,
    marginTop: Spacing.sm,
  },
  numericToggleText: {
    color: Colors.textMuted,
    fontSize: FontSize.sm,
    fontWeight: '700',
  },
  zoneGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.sm,
    marginTop: Spacing.sm,
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
