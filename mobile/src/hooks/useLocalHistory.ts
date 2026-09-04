import AsyncStorage from '@react-native-async-storage/async-storage';
import type { PitchResult } from '../types';

const STORAGE_KEY = 'speedgun_history_v1';
const MAX_RECORDS = 500;
// One storage key: serialize its read/modify/write operations, including clear.
let pending: Promise<unknown> = Promise.resolve();

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.catch(() => {});
  return result;
}

async function readHistory(): Promise<PitchResult[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((record) => (
    !record || typeof record.job_id !== 'string' || !record.job_id
    || !record.speed_info || typeof record.speed_info !== 'object' || Array.isArray(record.speed_info)
  ))) {
    // Do not silently replace unreadable records on the next save.
    throw new Error('投球紀錄格式異常，原始資料已保留。');
  }
  return parsed;
}

export function loadLocalHistory(): Promise<PitchResult[]> {
  return enqueue(readHistory);
}

export function saveResultToHistory(result: PitchResult): Promise<void> {
  return enqueue(async () => {
    const existing = await readHistory();
    // Deduplicate by job_id
    const filtered = existing.filter((r) => r.job_id !== result.job_id);
    const updated = [result, ...filtered].slice(0, MAX_RECORDS);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  });
}

export function clearLocalHistory(): Promise<void> {
  return enqueue(() => AsyncStorage.removeItem(STORAGE_KEY));
}
