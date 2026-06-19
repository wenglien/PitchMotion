import { requireNativeModule, EventEmitter, type EventSubscription } from 'expo-modules-core';

interface ProgressEvent {
  stage: string;
  progress: number;
  message: string;
}

interface AnalysisOptions {
  moundDistance?: number;
  strideCorrectionM?: number;
  confThreshold?: number;
  pitcherHeightM?: number;
  batterHeightM?: number;
  strikeZone?: { xMin: number; xMax: number; yMin: number; yMax: number } | null;
}

export interface VideoMetadata {
  fps?: number;
  capture_fps?: number;
  effective_fps?: number;
  effective_capture_fps?: number;
  interpolation_factor?: number;
  width?: number;
  height?: number;
  duration_s?: number;
  total_frames?: number;
  error?: string;
}

const ExpoSpeedgunModule = requireNativeModule('ExpoSpeedgun');
const emitter = new EventEmitter<{ onProgress: (event: ProgressEvent) => void }>(ExpoSpeedgunModule);

export function analyzeVideoOffline(
  videoUri: string,
  options: AnalysisOptions = {},
): Promise<Record<string, any>> {
  return ExpoSpeedgunModule.analyzeVideoOffline(videoUri, options);
}

export function getVideoMetadata(videoUri: string): Promise<VideoMetadata> {
  return ExpoSpeedgunModule.getVideoMetadata(videoUri);
}

export function addProgressListener(
  listener: (event: ProgressEvent) => void,
): EventSubscription {
  return emitter.addListener('onProgress', listener);
}
