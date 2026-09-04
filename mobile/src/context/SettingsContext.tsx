import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Settings, DEFAULT_SETTINGS } from '../types';
import { normalizeSettings } from '../utils/settings';

const STORAGE_KEY = 'speedgun_settings';

interface SettingsContextValue {
  settings: Settings;
  updateSettings: (partial: Partial<Settings>) => void;
  loaded: boolean;
}

const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  updateSettings: () => {},
  loaded: false,
});

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const edited = useRef(false);
  const pendingSave = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let active = true;
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (active && raw) setSettings(normalizeSettings(JSON.parse(raw)));
    }).catch(() => {
      if (active) {
        Alert.alert('無法讀取設定', '暫時使用預設值，原設定未被覆寫。分析前請重新確認投打距離與跨步補償。');
      }
    }).finally(() => {
      if (active) setLoaded(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!loaded || !edited.current) return;
    const serialized = JSON.stringify(settings);
    pendingSave.current = pendingSave.current
      .then(() => AsyncStorage.setItem(STORAGE_KEY, serialized))
      .catch(() => Alert.alert('設定尚未儲存', '本次設定仍有效，但重新開啟 App 前請再確認儲存空間並重新套用設定。'));
  }, [loaded, settings]);

  const updateSettings = useCallback((partial: Partial<Settings>) => {
    edited.current = true;
    setSettings((prev) => normalizeSettings({ ...prev, ...partial }));
  }, []);

  // Input fields must mount with the loaded calibration, not stale defaults.
  if (!loaded) return <View style={{ flex: 1, justifyContent: 'center' }}><ActivityIndicator accessibilityLabel="讀取設定中" /></View>;

  return (
    <SettingsContext.Provider value={{ settings, updateSettings, loaded }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  return useContext(SettingsContext);
}
