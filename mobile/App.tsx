import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SettingsProvider } from './src/context/SettingsContext';
import { ResultProvider } from './src/context/ResultContext';
import BottomTabs from './src/navigation/BottomTabs';
import ErrorBoundary from './src/components/ErrorBoundary';
import { Colors } from './src/theme';

// Match React Navigation's container background to our app bg so screen
// transitions and tab switches don't briefly flash white.
const NavTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: Colors.bg,
    card: Colors.bg,
    border: Colors.border,
    text: Colors.text,
    primary: Colors.accent,
    notification: Colors.accent,
  },
};

export default function App() {
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <SettingsProvider>
          <ResultProvider>
            <NavigationContainer theme={NavTheme}>
              <StatusBar style="dark" />
              <BottomTabs />
            </NavigationContainer>
          </ResultProvider>
        </SettingsProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}
