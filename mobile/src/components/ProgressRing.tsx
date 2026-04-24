import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Colors } from '../theme';

interface Props {
  pct: number;
  isUpload: boolean;
  stageColor?: string;
}

export default function ProgressRing({ pct, isUpload, stageColor }: Props) {
  const R = 26;
  const C = 2 * Math.PI * R;
  const off = C - (pct / 100) * C;

  return (
    <View style={styles.wrap}>
      <Svg width={68} height={68} viewBox="0 0 68 68">
        <Circle cx={34} cy={34} r={R} fill="none" stroke="#e5e7eb" strokeWidth={5} />
        <Circle
          cx={34}
          cy={34}
          r={R}
          fill="none"
          stroke={isUpload ? '#3b82f6' : (stageColor || '#2563eb')}
          strokeWidth={5}
          strokeLinecap="round"
          strokeDasharray={`${C}`}
          strokeDashoffset={off}
          rotation={-90}
          origin="34, 34"
        />
      </Svg>
      <View style={styles.pctWrap}>
        <Text style={styles.pctText}>{pct}%</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: 68,
    height: 68,
    flexShrink: 0,
  },
  pctWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pctText: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.text,
  },
});
