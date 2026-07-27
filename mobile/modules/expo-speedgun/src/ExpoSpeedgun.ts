import { requireNativeModule, EventEmitter, type EventSubscription } from 'expo-modules-core';

export interface NativeProgressEvent {
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

export interface NativeImagePoint {
  x: number;
  y: number;
}

export interface NativeTrajectoryPoint {
  x: number;
  y: number;
}

export interface NativeTrajectorySample {
  frame_index: number;
  t_s: number;
  x_norm: number;
  y_norm: number;
  is_synthetic?: boolean;
  confidence?: number;
}

export interface NativeTrajectoryMetadata {
  source?: string;
  mound_distance_m?: number;
  total_distance_m?: number;
  release_time_s?: number;
  catch_time_s?: number;
  plate_x_norm?: number;
  plate_y_norm?: number;
  plate_crossing_x_m?: number;
  plate_crossing_y_m?: number;
  release_point_x_m?: number;
  release_point_y_m?: number;
  release_point_z_m?: number;
  is_strike?: boolean;
  horizontal_break_cm?: number;
  induced_vertical_break_cm?: number;
  strike_zone_width_cm?: number;
  strike_zone_height_cm?: number;
  video_width?: number;
  video_height?: number;
}

export interface NativeSpeedInfo {
  release_speed_kmh?: number;
  initial_speed_kmh?: number;
  max_speed_kmh?: number;
  total_distance_m?: number;
  effective_distance_m?: number;
  flight_time_s?: number;
  horizontal_break_cm?: number;
  vertical_break_cm?: number;
  induced_vertical_break_cm?: number;
  total_break_cm?: number;
  break_angle_deg?: number;
  break_confidence?: number;
  break_gravity_drop_cm?: number;
  break_fit_r2?: number;
  break_endpoint_source?: string;
  break_samples?: number;
  break_actual_sample_ratio?: number;
  break_cm_per_px_x?: number;
  break_cm_per_px_y?: number;
  pitch_type?: string;
  pitch_confidence?: number;
  calculation_method?: string;
  physics_clamped?: boolean;
  trajectory_quality_warning?: string | boolean;
  release_point?: NativeImagePoint;
  catch_point?: NativeImagePoint;
  glove_point?: NativeImagePoint;
  plate_x_norm?: number;
  plate_y_norm?: number;
  catch_point_confidence?: number;
  catch_point_source?: string;
  plate_fit_error_px?: number;
  plate_extrapolated_frames?: number;
  plate_zone?: { x_min: number; x_max: number; y_min: number; y_max: number };
  batter_height_m?: number;
  strike_zone_width_cm?: number;
  strike_zone_height_cm?: number;
  strike_zone_rule?: string;
  pitch_loc_x?: number;
  pitch_loc_y?: number;
  is_strike?: boolean;
  no_ball_detected?: boolean;
  estimated_distance_m?: number;
  distance_source?: 'manual' | 'pose_estimated' | 'default';
  distance_warning?: string;
  ttc_status?: string;
  flight_time_source?: string;
  ttc_flight_time_s?: number;
  visual_flight_time_s?: number;
  release_frame_idx?: number;
  release_frame_source?: 'pose' | 'pose_refined' | 'fallback';
  first_ball_frame_idx?: number;
  catch_frame_idx?: number;
  release_time_s?: number;
  first_ball_time_s?: number;
  catch_time_s?: number;
}

export interface NativeAnalysisResult {
  error?: string;
  job_id?: string;
  speed_info?: NativeSpeedInfo;
  overlay_uri?: string;
  total_frames?: number;
  fps?: number;
  video_width?: number;
  video_height?: number;
  trajectory_count?: number;
  trajectory_actual_count?: number;
  trajectory_synthetic_count?: number;
  yolo_frames_processed?: number;
  yolo_raw_detection_frames?: number;
  yolo_total_detections?: number;
  yolo_ball_in_frame_count?: number;
  source_fps?: number;
  capture_fps?: number;
  effective_capture_fps?: number;
  interpolation_factor?: number;
  trajectory_points_norm?: NativeTrajectoryPoint[];
  trajectory_samples?: NativeTrajectorySample[];
  trajectory_metadata?: NativeTrajectoryMetadata;
}

const ExpoSpeedgunModule = requireNativeModule('ExpoSpeedgun');
const emitter = new EventEmitter<{ onProgress: (event: NativeProgressEvent) => void }>(ExpoSpeedgunModule);

export function analyzeVideoOffline(
  videoUri: string,
  options: AnalysisOptions = {},
): Promise<NativeAnalysisResult> {
  return ExpoSpeedgunModule.analyzeVideoOffline(videoUri, options);
}

export function getVideoMetadata(videoUri: string): Promise<VideoMetadata> {
  return ExpoSpeedgunModule.getVideoMetadata(videoUri);
}

export function addProgressListener(
  listener: (event: NativeProgressEvent) => void,
): EventSubscription {
  return emitter.addListener('onProgress', listener);
}
