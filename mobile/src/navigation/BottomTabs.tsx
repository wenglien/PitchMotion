import React, { useEffect } from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
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
        tabBarIcon: ({ color, size }) => (
          <Ionicons name={icons[route.name]} size={size} color={color} />
        ),
      })}
    >
      <Tab.Screen
        name="Analyze"
        component={AnalyzeScreen}
        options={{ title: 'SpeedGun' }}
      />
      <Tab.Screen
        name="Result"
        component={ResultScreen}
        options={{ title: 'Result' }}
        listeners={({ navigation }) => ({
          tabPress: () => {
            clearNewResultFlag();
          },
        })}
      />
      <Tab.Screen
        name="History"
        component={HistoryStack}
        options={{ headerShown: false }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ title: 'Settings' }}
      />
    </Tab.Navigator>
  );
}
