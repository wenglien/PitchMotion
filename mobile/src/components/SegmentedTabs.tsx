import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Colors } from '../theme';

interface Props {
  tabs: string[];
  activeTab: string;
  onSelect: (tab: string) => void;
}

export default function SegmentedTabs({ tabs, activeTab, onSelect }: Props) {
  return (
    <View style={styles.container}>
      {tabs.map((t) => (
        <TouchableOpacity
          key={t}
          style={[styles.tab, activeTab === t && styles.tabActive]}
          onPress={() => onSelect(t)}
          activeOpacity={0.7}
        >
          <Text style={[styles.label, activeTab === t && styles.labelActive]}>
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
    borderRadius: 10,
    padding: 3,
    gap: 2,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  tab: {
    flex: 1,
    paddingVertical: 7,
    paddingHorizontal: 4,
    borderRadius: 8,
    alignItems: 'center',
  },
  tabActive: {
    backgroundColor: Colors.surface,
    shadowColor: '#000',
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
