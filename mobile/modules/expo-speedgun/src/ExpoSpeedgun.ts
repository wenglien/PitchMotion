import { requireNativeModule, EventEmitter, type EventSubscription } from 'expo-modules-core';

interface ProgressEvent {
  stage: string;
  progress: number;
  message: string;
}

type Vector3 = [number, number, number];
type CameraMatrix3x3 = [Vector3, Vector3, Vector3];

interface ABSCalibration2D {
  mode: '2d';
  zone:
    | { left: number; right: number; top: number; bottom: number }
    | {
        top_left: [number, number];
        top_right: [number, number];
        bottom_right: [number, number];
        bottom_left: [number, number];
      };
  depth_offset?: { x: number; y: number };
}

interface ABSCalibration3D {
  mode: '3d';
  zone: { center: Vector3; width: number; height: number; depth: number };
  camera: {
    matrix: CameraMatrix3x3;
    rvec: Vector3;
    tvec: Vector3;
    dist_coeffs?: number[];
  };
}

export type ABSCalibration = ABSCalibration2D | ABSCalibration3D;

export interface AnalysisOptions {
  moundDistance?: number;
  strideCorrectionM?: number;
  confThreshold?: number;
  pitcherHeightM?: number;
  batterHeightM?: number;
  strikeZone?: { xMin: number; xMax: number; yMin: number; yMax: number } | null;
  absCalibration?: ABSCalibration | null;
  absCalibrationJson?: string | null;
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
