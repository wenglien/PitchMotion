import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer } from '@react-navigation/native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SettingsProvider } from './src/context/SettingsContext';
import { ResultProvider } from './src/context/ResultContext';
import BottomTabs from './src/navigation/BottomTabs';

export default function App() {
  return (
    <SafeAreaProvider>
      <SettingsProvider>
        <ResultProvider>
          <NavigationContainer>
            <StatusBar style="dark" />
            <BottomTabs />
          </NavigationContainer>
        </ResultProvider>
      </SettingsProvider>
    </SafeAreaProvider>
  );
}
