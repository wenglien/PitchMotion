import { useRef, useCallback } from 'react';
import { analyzeVideoOffline, addProgressListener } from '../../modules/expo-speedgun';
import { PitchResult, StrikeZoneCalibration } from '../types';

/** Maps native stage names → pipeline stage IDs used by AnalysisProgress */
const STAGE_MAP: Record<string, string> = {
  init: 'init',
  decode: 'init',
  setup: 'init',
  detection: 'detection',
  detecting: 'detection',   // native stage name used by SpeedgunPipeline
  gap_fill: 'detection',
  tracking: 'tracking',
  calculating: 'speed',     // native stage name used by SpeedgunPipeline
  speed: 'speed',
  pitch_type: 'pitch_type',
  overlay: 'overlay',
  done: 'done',
};

/** Maps native stage names → user-facing messages */
function nativeMessageToUserMsg(stage: string, message: string): string {
  if (!message) {
    const defaults: Record<string, string> = {
      init: '初始化 AI 模型…',
      decode: '解碼影片…',
      detection: '偵測棒球中…',
      gap_fill: '補幀修復…',
      tracking: '追蹤球路軌跡…',
      speed: '計算球速…',
      pitch_type: '辨識球種…',
      overlay: '生成 Overlay 影片…',
      done: '分析完成！',
    };
    return defaults[stage] || '處理中…';
  }
  return message;
}

interface OfflineAnalysisCallbacks {
  onStage?: (stageId: string) => void;
  onMessage?: (msg: string) => void;
  onProgress?: (pct: number) => void;
}

export function useOfflineAnalysis() {
  const abortRef = useRef(false);

  const analyze = useCallback(
    async (
      videoUri: string,
      opts: {
        moundDistanceM?: number;
        strideCorrectionM?: number;
        confThreshold?: number;
        pitcherHeightM?: number;
        batterHeightM?: number;
        strikeZone?: StrikeZoneCalibration | null;
      },
      callbacks?: OfflineAnalysisCallbacks,
    ): Promise<PitchResult> => {
      abortRef.current = false;

      // Subscribe to progress events from native module
      const sub = addProgressListener((event) => {
        if (abortRef.current) return;

        const stageId = STAGE_MAP[event.stage] || event.stage;
        const userMsg = nativeMessageToUserMsg(event.stage, event.message);

        callbacks?.onStage?.(stageId);
        callbacks?.onMessage?.(userMsg);

        // Map progress (0-1) to percentage for the overall pipeline
        // We estimate: detection=40%, tracking=15%, speed=10%, overlay=30%, other=5%
        let overallPct = 0;
        switch (stageId) {
          case 'init':
            overallPct = Math.round(event.progress * 5);
            break;
          case 'detection':
            overallPct = 5 + Math.round(event.progress * 40);
            break;
          case 'tracking':
            overallPct = 45 + Math.round(event.progress * 15);
            break;
          case 'speed':
            overallPct = 60 + Math.round(event.progress * 5);
            break;
          case 'pitch_type':
            overallPct = 65 + Math.round(event.progress * 5);
            break;
          case 'overlay':
            overallPct = 70 + Math.round(event.progress * 28);
            break;
          case 'done':
            overallPct = 100;
            break;
          default:
            overallPct = Math.round(event.progress * 100);
        }
        callbacks?.onProgress?.(Math.min(overallPct, 100));
      });

      try {
        const raw = await analyzeVideoOffline(videoUri, {
          moundDistance: opts.moundDistanceM,
          strideCorrectionM: opts.strideCorrectionM,
          confThreshold: opts.confThreshold,
          pitcherHeightM: opts.pitcherHeightM,
          batterHeightM: opts.batterHeightM,
          strikeZone: opts.strikeZone,
        });

        if (raw.error) {
          throw new Error(raw.error as string);
        }

        // Convert native result → PitchResult
        const speedInfo = (raw.speed_info as Record<string, any>) || {};
        const result: PitchResult = {
          job_id: (raw.job_id as string) || `offline_${Date.now()}`,
          speed_info: {
            release_speed_kmh: speedInfo.release_speed_kmh,
            initial_speed_kmh: speedInfo.initial_speed_kmh,
            max_speed_kmh: speedInfo.max_speed_kmh,
            total_distance_m: speedInfo.total_distance_m,
            effective_distance_m: speedInfo.effective_distance_m,
            flight_time_s: speedInfo.flight_time_s,
            horizontal_break_cm: speedInfo.horizontal_break_cm,
            vertical_break_cm: speedInfo.vertical_break_cm,
            induced_vertical_break_cm: speedInfo.induced_vertical_break_cm,
            total_break_cm: speedInfo.total_break_cm,
            break_angle_deg: speedInfo.break_angle_deg,
            break_confidence: speedInfo.break_confidence,
            break_gravity_drop_cm: speedInfo.break_gravity_drop_cm,
            break_fit_r2: speedInfo.break_fit_r2,
            break_endpoint_source: speedInfo.break_endpoint_source,
            break_samples: speedInfo.break_samples,
            break_actual_sample_ratio: speedInfo.break_actual_sample_ratio,
            break_cm_per_px_x: speedInfo.break_cm_per_px_x,
            break_cm_per_px_y: speedInfo.break_cm_per_px_y,
            pitch_type: speedInfo.pitch_type,
            pitch_confidence: speedInfo.pitch_confidence,
            calculation_method: speedInfo.calculation_method,
            physics_clamped: speedInfo.physics_clamped,
            trajectory_quality_warning: speedInfo.trajectory_quality_warning,
            plate_x_norm: speedInfo.plate_x_norm,
            plate_y_norm: speedInfo.plate_y_norm,
            catch_point_confidence: speedInfo.catch_point_confidence,
            catch_point_source: speedInfo.catch_point_source,
            plate_fit_error_px: speedInfo.plate_fit_error_px,
            plate_extrapolated_frames: speedInfo.plate_extrapolated_frames,
            plate_zone: speedInfo.plate_zone,
            batter_height_m: speedInfo.batter_height_m,
            strike_zone_width_cm: speedInfo.strike_zone_width_cm,
            strike_zone_height_cm: speedInfo.strike_zone_height_cm,
            strike_zone_rule: speedInfo.strike_zone_rule,
            pitch_loc_x: speedInfo.pitch_loc_x,
            pitch_loc_y: speedInfo.pitch_loc_y,
            is_strike: speedInfo.is_strike,
            no_ball_detected: speedInfo.no_ball_detected,
            estimated_distance_m: speedInfo.estimated_distance_m,
            distance_source: speedInfo.distance_source,
            distance_warning: speedInfo.distance_warning,
            ttc_status: speedInfo.ttc_status,
            flight_time_source: speedInfo.flight_time_source,
            ttc_flight_time_s: speedInfo.ttc_flight_time_s,
            visual_flight_time_s: speedInfo.visual_flight_time_s,
            release_frame_idx: speedInfo.release_frame_idx,
            release_frame_source: speedInfo.release_frame_source,
            first_ball_frame_idx: speedInfo.first_ball_frame_idx,
            catch_frame_idx: speedInfo.catch_frame_idx,
          },
          overlay_url: raw.overlay_uri as string | undefined,
          overlay_uri: raw.overlay_uri as string | undefined,
          created_at: new Date().toISOString(),
          // YOLO detection stats (pass through from native)
          total_frames: raw.total_frames as number | undefined,
          fps: raw.fps as number | undefined,
          video_width: raw.video_width as number | undefined,
          video_height: raw.video_height as number | undefined,
          trajectory_count: raw.trajectory_count as number | undefined,
          yolo_frames_processed: raw.yolo_frames_processed as number | undefined,
          yolo_raw_detection_frames: raw.yolo_raw_detection_frames as number | undefined,
          yolo_total_detections: raw.yolo_total_detections as number | undefined,
          yolo_ball_in_frame_count: raw.yolo_ball_in_frame_count as number | undefined,
          trajectory_points_norm: raw.trajectory_points_norm as import('../types').TrajectoryPoint[] | undefined,
        };

        return result;
      } finally {
        sub.remove();
      }
    },
    [],
  );

  const cancel = useCallback(() => {
    abortRef.current = true;
  }, []);

  return { analyze, cancel };
}
