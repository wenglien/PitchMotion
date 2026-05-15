import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';
import { Colors } from '../theme';
import { BottomTabParamList } from './types';
import { useResult } from '../context/ResultContext';
import AnalyzeScreen from '../screens/AnalyzeScreen';
import ResultScreen from '../screens/ResultScreen';
import HistoryStack from './HistoryStack';
import SettingsScreen from '../screens/SettingsScreen';

const Tab = createBottomTabNavigator<BottomTabParamList>();

const icons: Record<string, keyof typeof Ionicons.glyphMap> = {
  Analyze: 'videocam-outline',
  Result: 'speedometer-outline',
  History: 'time-outline',
  Settings: 'settings-outline',
};

const TAB_LABELS: Record<string, string> = {
  Analyze: '分析',
  Result: '結果',
  History: '紀錄',
  Settings: '設定',
};

export default function BottomTabs() {
  const { hasNewResult, clearNewResultFlag } = useResult();

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerStyle: { backgroundColor: Colors.bg, shadowColor: 'transparent', elevation: 0 },
        headerTitleStyle: { fontWeight: '800', color: Colors.text, fontSize: 18 },
        tabBarStyle: {
          backgroundColor: Colors.surface,
          borderTopWidth: 1,
          borderTopColor: Colors.border,
          height: 68,
          paddingBottom: 10,
          paddingTop: 8,
        },
        tabBarActiveTintColor: Colors.accent,
        tabBarInactiveTintColor: Colors.textMuted,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '800',
          letterSpacing: 0.1,
        },
        tabBarIcon: ({ color, size, focused }) => {
          const showDot = route.name === 'Result' && hasNewResult && !focused;
          return (
            <View>
              <Ionicons name={icons[route.name]} size={size} color={color} />
              {showDot && (
                <View
                  style={{
                    position: 'absolute',
                    top: -2,
                    right: -4,
                    width: 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: Colors.red,
                    borderWidth: 1,
                    borderColor: Colors.surface,
                  }}
                />
              )}
            </View>
          );
        },
        tabBarAccessibilityLabel: TAB_LABELS[route.name],
      })}
    >
      <Tab.Screen
        name="Analyze"
        component={AnalyzeScreen}
        options={{ title: 'SpeedGun', tabBarLabel: TAB_LABELS.Analyze }}
      />
      <Tab.Screen
        name="Result"
        component={ResultScreen}
        options={{ title: '分析結果', tabBarLabel: TAB_LABELS.Result }}
        listeners={() => ({
          tabPress: () => {
            clearNewResultFlag();
          },
        })}
      />
      <Tab.Screen
        name="History"
        component={HistoryStack}
        options={{ headerShown: false, tabBarLabel: TAB_LABELS.History }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ title: '設定', tabBarLabel: TAB_LABELS.Settings }}
      />
    </Tab.Navigator>
  );
}
