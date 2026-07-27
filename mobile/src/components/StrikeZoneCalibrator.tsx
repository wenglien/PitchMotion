import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Line, Rect, Text as SvgText } from 'react-native-svg';
import { StrikeZoneCalibration } from '../types';
import { Colors, FontSize, Radius, Spacing, TouchTarget, Typography } from '../theme';

interface Props {
  zone: StrikeZoneCalibration;
  onChange: (zone: StrikeZoneCalibration) => void;
}

const VIEW_W = 320;
const VIEW_H = 190;
const STEP = 0.025;
const MIN_SIZE = 0.12;

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function rounded(value: number) {
  return Math.round(value * 1000) / 1000;
}

export default function StrikeZoneCalibrator({ zone, onChange }: Props) {
  const [layoutWidth, setLayoutWidth] = useState(1);

  const commit = (next: StrikeZoneCalibration) => {
    onChange({
      xMin: rounded(clamp(next.xMin)),
      xMax: rounded(clamp(next.xMax)),
      yMin: rounded(clamp(next.yMin)),
      yMax: rounded(clamp(next.yMax)),
    });
  };

  const move = (dx: number, dy: number) => {
    const width = zone.xMax - zone.xMin;
    const height = zone.yMax - zone.yMin;
    const xMin = clamp(zone.xMin + dx, 0, 1 - width);
    const yMin = clamp(zone.yMin + dy, 0, 1 - height);
    commit({ xMin, xMax: xMin + width, yMin, yMax: yMin + height });
  };

  const resize = (dw: number, dh: number) => {
    const cx = (zone.xMin + zone.xMax) / 2;
    const cy = (zone.yMin + zone.yMax) / 2;
    const width = clamp(zone.xMax - zone.xMin + dw, MIN_SIZE, 0.9);
    const height = clamp(zone.yMax - zone.yMin + dh, MIN_SIZE, 0.9);
    const xMin = clamp(cx - width / 2, 0, 1 - width);
    const yMin = clamp(cy - height / 2, 0, 1 - height);
    commit({ xMin, xMax: xMin + width, yMin, yMax: yMin + height });
  };

  const setCenter = (locationX: number, locationY: number) => {
    const width = zone.xMax - zone.xMin;
    const height = zone.yMax - zone.yMin;
    const x = clamp(locationX / layoutWidth);
    const y = clamp(locationY / VIEW_H);
    const xMin = clamp(x - width / 2, 0, 1 - width);
    const yMin = clamp(y - height / 2, 0, 1 - height);
    commit({ xMin, xMax: xMin + width, yMin, yMax: yMin + height });
  };

  const zoneX = zone.xMin * VIEW_W;
  const zoneY = zone.yMin * VIEW_H;
  const zoneW = (zone.xMax - zone.xMin) * VIEW_W;
  const zoneH = (zone.yMax - zone.yMin) * VIEW_H;

  return (
    <View>
      <Text style={styles.instructions}>點一下畫面定位好球帶，再用下方控制微調位置與大小。</Text>
      <TouchableOpacity
        activeOpacity={0.95}
        style={styles.preview}
        onLayout={(event) => setLayoutWidth(event.nativeEvent.layout.width)}
        onPress={(event) => setCenter(event.nativeEvent.locationX, event.nativeEvent.locationY)}
        accessibilityRole="adjustable"
        accessibilityLabel="視覺化好球帶校正區"
        accessibilityHint="點擊畫面可移動好球帶中心"
      >
        <Svg width="100%" height={VIEW_H} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}>
          <Rect x={0} y={0} width={VIEW_W} height={VIEW_H} rx={16} fill={Colors.panel} />
          {[1, 2].map((i) => (
            <React.Fragment key={i}>
              <Line x1={(VIEW_W / 3) * i} x2={(VIEW_W / 3) * i} y1={0} y2={VIEW_H} stroke="#334155" strokeWidth={1} />
              <Line x1={0} x2={VIEW_W} y1={(VIEW_H / 3) * i} y2={(VIEW_H / 3) * i} stroke="#334155" strokeWidth={1} />
            </React.Fragment>
          ))}
          <SvgText x={16} y={24} fill="#94a3b8" fontSize={11} fontWeight="700">主審視角</SvgText>
          <Rect x={zoneX} y={zoneY} width={zoneW} height={zoneH} rx={5} fill={Colors.accent} fillOpacity={0.18} stroke={Colors.cyan} strokeWidth={3} />
          <Line x1={zoneX + zoneW / 2 - 7} x2={zoneX + zoneW / 2 + 7} y1={zoneY + zoneH / 2} y2={zoneY + zoneH / 2} stroke="#f8fafc" strokeWidth={1.5} />
          <Line x1={zoneX + zoneW / 2} x2={zoneX + zoneW / 2} y1={zoneY + zoneH / 2 - 7} y2={zoneY + zoneH / 2 + 7} stroke="#f8fafc" strokeWidth={1.5} />
        </Svg>
      </TouchableOpacity>

      <Text style={styles.controlLabel}>移動位置</Text>
      <View style={styles.controlRow}>
        <AdjustButton icon="arrow-back" label="向左" onPress={() => move(-STEP, 0)} />
        <AdjustButton icon="arrow-up" label="向上" onPress={() => move(0, -STEP)} />
        <AdjustButton icon="arrow-down" label="向下" onPress={() => move(0, STEP)} />
        <AdjustButton icon="arrow-forward" label="向右" onPress={() => move(STEP, 0)} />
      </View>

      <Text style={styles.controlLabel}>調整大小</Text>
      <View style={styles.controlRow}>
        <AdjustButton icon="contract-outline" label="縮窄" onPress={() => resize(-STEP * 2, 0)} />
        <AdjustButton icon="expand-outline" label="加寬" onPress={() => resize(STEP * 2, 0)} />
        <AdjustButton icon="remove-outline" label="降低" onPress={() => resize(0, -STEP * 2)} />
        <AdjustButton icon="add-outline" label="增高" onPress={() => resize(0, STEP * 2)} />
      </View>
    </View>
  );
}

function AdjustButton({ icon, label, onPress }: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={styles.adjustButton}
      onPress={onPress}
      activeOpacity={0.72}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={18} color={Colors.text} />
      <Text style={styles.adjustText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  instructions: { ...Typography.caption, marginBottom: Spacing.sm },
  preview: {
    width: '100%',
    height: VIEW_H,
    borderRadius: Radius.xl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#334155',
  },
  controlLabel: {
    marginTop: Spacing.md,
    marginBottom: Spacing.xs,
    color: Colors.textMuted,
    fontSize: FontSize.sm,
    fontWeight: '800',
  },
  controlRow: { flexDirection: 'row', gap: Spacing.xs },
  adjustButton: {
    flex: 1,
    minHeight: TouchTarget.min,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.surface2,
  },
  adjustText: { color: Colors.textMuted, fontSize: FontSize.xs, fontWeight: '700' },
});
