import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SettingsProvider } from './src/context/SettingsContext';
import { ResultProvider } from './src/context/ResultContext';
import BottomTabs from './src/navigation/BottomTabs';
import ErrorBoundary from './src/components/ErrorBoundary';
import { Colors } from './src/theme';
import { RootStackParamList } from './src/navigation/types';
import TrajectorySimulationScreen from './src/screens/TrajectorySimulationScreen';

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

const RootStack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
        <SafeAreaProvider>
          <SettingsProvider>
            <ResultProvider>
              <NavigationContainer theme={NavTheme}>
                <StatusBar style="dark" />
                <RootStack.Navigator
                screenOptions={{
                  headerStyle: { backgroundColor: Colors.bg },
                  headerTintColor: Colors.accent,
                  headerTitleStyle: { fontWeight: '800', color: Colors.text, fontSize: 16 },
                  headerShadowVisible: false,
                  headerBackTitle: '',
                }}
              >
                <RootStack.Screen
                  name="MainTabs"
                  component={BottomTabs}
                  options={{ headerShown: false }}
                />
                <RootStack.Screen
                  name="TrajectorySimulation"
                  component={TrajectorySimulationScreen}
                  options={({ route }) => ({
                    title: route.params.title ?? '3D 軌跡模擬',
                    presentation: 'card',
                  })}
                />
              </RootStack.Navigator>
            </NavigationContainer>
          </ResultProvider>
        </SettingsProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
    </GestureHandlerRootView>
  );
}
