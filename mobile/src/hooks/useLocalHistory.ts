import { useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { PitchResult } from '../types';

const STORAGE_KEY = 'speedgun_history_v1';
const MAX_RECORDS = 500;

export async function loadLocalHistory(): Promise<PitchResult[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveResultToHistory(result: PitchResult): Promise<void> {
  try {
    const existing = await loadLocalHistory();
    // Deduplicate by job_id
    const filtered = existing.filter((r) => r.job_id !== result.job_id);
    const updated = [result, ...filtered].slice(0, MAX_RECORDS);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {}
}

export async function clearLocalHistory(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {}
}
