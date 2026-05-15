export interface SpeedInfo {
  release_speed_kmh?: number;
  initial_speed_kmh?: number;
  max_speed_kmh?: number;
  total_distance_m?: number;
  effective_distance_m?: number;
  flight_time_s?: number;
  // Ball displacement (break) in centimetres at the plate plane.
  // Horizontal: +right / −left.  Vertical: +down / −up (image coords).
  horizontal_break_cm?: number;
  vertical_break_cm?: number;            // image-frame; +down
  induced_vertical_break_cm?: number;    // MLB-style; +up (gravity removed)
  total_break_cm?: number;
  break_angle_deg?: number;
  break_confidence?: number;
  pitch_type?: string;
  pitch_confidence?: number;
  spin_rpm?: number;
  calculation_method?: string;
  physics_clamped?: boolean;
  trajectory_quality_warning?: string | boolean;
  plate_x_norm?: number;
  plate_y_norm?: number;
  pitch_loc_x?: number;
  pitch_loc_y?: number;
  is_strike?: boolean;
  plate_zone?: { x_min: number; x_max: number; y_min: number; y_max: number };
  no_ball_detected?: boolean;
  estimated_distance_m?: number;
  distance_source?: 'manual' | 'pose_estimated' | 'default';
  distance_warning?: string;
  ttc_status?: string;
  release_frame_idx?: number;
  release_frame_source?: 'pose' | 'fallback';
  first_ball_frame_idx?: number;
  catch_frame_idx?: number;
}

export interface StrikeZoneCalibration {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface TrajectoryPoint {
  x: number;   // normalised 0-1 (left → right in video frame)
  y: number;   // normalised 0-1 (top  → bottom in video frame)
}

export interface PitchResult {
  job_id: string;
  speed_info: SpeedInfo;
  overlay_url?: string;
  overlay_uri?: string;    // local file URI from offline analysis
  original_url?: string;
  created_at?: string;
  // YOLO detection stats (offline mode only)
  total_frames?: number;
  fps?: number;
  video_width?: number;
  video_height?: number;
  trajectory_count?: number;
  trajectory_points_norm?: TrajectoryPoint[];   // sampled, normalised to video frame
  yolo_frames_processed?: number;
  yolo_raw_detection_frames?: number;
  yolo_total_detections?: number;
  yolo_ball_in_frame_count?: number;
}

export interface SessionPitch {
  job_id: string;
  plate_x_norm: number | null;
  plate_y_norm: number | null;
  pitch_type: string | null;
  speed_kmh: number | null;
  // Measured break (cm) — used by StrikeZone to draw a Statcast-style trajectory
  // shape derived from real data instead of a generic Bezier per pitch.
  horizontal_break_cm?: number | null;
  induced_vertical_break_cm?: number | null;
  trajectory_points_norm?: TrajectoryPoint[];
}

export interface Session {
  dateLabel: string;
  records: PitchResult[];
}

export type AnalysisMode = 'offline' | 'online';

export interface Settings {
  moundDistanceM: number;          // 0 = 未設定（走自動估算）; >0 = 使用者手動量測
  strideCorrectionM: number;
  confThreshold: number;
  backendUrl: string;
  analysisMode: AnalysisMode;
  pitcherHeightM?: number;         // 可選，提高 pose 自動估距精度
  strikeZone?: StrikeZoneCalibration | null;
}

export const DEFAULT_SETTINGS: Settings = {
  moundDistanceM: 0,               // 預設不填，強制使用者輸入實際距離
  strideCorrectionM: 0,
  confThreshold: 0.03,
  // Empty by default — offline mode (the default) doesn't need a backend, and
  // a real localhost default would silently 'work' in the simulator while being
  // permanently broken on every shipped device. Force users who switch to
  // online mode to enter a real URL via Settings.
  backendUrl: '',
  analysisMode: 'offline',
  pitcherHeightM: undefined,
  strikeZone: null,
};
