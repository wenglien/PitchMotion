import { useRef, useCallback } from 'react';
import {
  analyzeVideoOffline,
  addProgressListener,
  type ABSCalibration,
  type AnalysisOptions,
} from '../../modules/expo-speedgun';
import { toPitchResult } from '../adapters/nativeAnalysis';
import { PitchResult, StrikeZoneCalibration } from '../types';
import { normalizePipelineProgress, type PipelineProgressState } from '../utils/pipelineStages';

interface OfflineAnalysisCallbacks {
  onProgress?: (progress: PipelineProgressState) => void;
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
        absCalibration?: ABSCalibration | null;
        absCalibrationJson?: string | null;
      },
      callbacks?: OfflineAnalysisCallbacks,
    ): Promise<PitchResult> => {
      abortRef.current = false;

      // Subscribe to progress events from native module
      const sub = addProgressListener((event) => {
        if (abortRef.current) return;
        callbacks?.onProgress?.(normalizePipelineProgress(event));
      });

      try {
        const nativeOptions: AnalysisOptions = {
          moundDistance: opts.moundDistanceM,
          strideCorrectionM: opts.strideCorrectionM,
          confThreshold: opts.confThreshold,
          pitcherHeightM: opts.pitcherHeightM,
          batterHeightM: opts.batterHeightM,
          strikeZone: opts.strikeZone,
        };
        if (opts.absCalibration != null) {
          nativeOptions.absCalibration = opts.absCalibration;
        }
        if (opts.absCalibrationJson != null && opts.absCalibrationJson.trim() !== '') {
          nativeOptions.absCalibrationJson = opts.absCalibrationJson;
        }

        const raw = await analyzeVideoOffline(videoUri, nativeOptions);
        return toPitchResult(raw);
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
