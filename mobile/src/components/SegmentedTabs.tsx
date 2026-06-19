import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, StyleProp, ViewStyle } from 'react-native';
import { Colors, Radius, TouchTarget } from '../theme';

interface Props {
  tabs: string[];
  activeTab: string;
  onSelect: (tab: string) => void;
  containerStyle?: StyleProp<ViewStyle>;
}

export default function SegmentedTabs({ tabs, activeTab, onSelect, containerStyle }: Props) {
  return (
    <View style={[styles.container, containerStyle]}>
      {tabs.map((t) => (
        <TouchableOpacity
          key={t}
          style={[styles.tab, activeTab === t && styles.tabActive]}
          onPress={() => onSelect(t)}
          activeOpacity={0.7}
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === t }}
          accessibilityLabel={t}
        >
          <Text
            style={[styles.label, activeTab === t && styles.labelActive]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.82}
          >
            {t}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginVertical: 10,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.lg,
    padding: 3,
    gap: 2,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tab: {
    flex: 1,
    minHeight: TouchTarget.min,
    paddingVertical: 7,
    paddingHorizontal: 4,
    borderRadius: Radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabActive: {
    backgroundColor: Colors.surface,
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 3,
    elevation: 2,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.textMuted,
  },
  labelActive: {
    color: Colors.accent,
  },
});
