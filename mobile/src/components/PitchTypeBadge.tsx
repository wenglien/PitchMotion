import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { pitchColor } from '../utils/conversions';

interface Props {
  type: string;
  confidence?: number | null;
}

export default function PitchTypeBadge({ type, confidence }: Props) {
  return (
    <View style={[styles.badge, { backgroundColor: pitchColor(type) }]}>
      <Text style={styles.text}>
        {type}
        {confidence != null ? `  ${confidence}%` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 14,
    paddingVertical: 4,
    borderRadius: 99,
    alignSelf: 'flex-start',
  },
  text: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fff',
  },
});
