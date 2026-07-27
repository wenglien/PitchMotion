import React, { createContext, useContext, useState, useCallback } from 'react';
import { PitchResult, SessionPitch } from '../types';
import { saveResultToHistory } from '../hooks/useLocalHistory';

export interface AnalysisLogEntry {
  msg: string;
  isError: boolean;
}

interface ResultContextValue {
  result: PitchResult | null;
  sessionPitches: SessionPitch[];
  completeAnalysis: (result: PitchResult, logs: AnalysisLogEntry[]) => void;
  clearPitches: () => void;
  hasNewResult: boolean;
  clearNewResultFlag: () => void;
  analysisLogs: AnalysisLogEntry[];
}

const ResultContext = createContext<ResultContextValue>({
  result: null,
  sessionPitches: [],
  completeAnalysis: () => {},
  clearPitches: () => {},
  hasNewResult: false,
  clearNewResultFlag: () => {},
  analysisLogs: [],
});

export function ResultProvider({ children }: { children: React.ReactNode }) {
  const [result, setResultState] = useState<PitchResult | null>(null);
  const [sessionPitches, setSessionPitches] = useState<SessionPitch[]>([]);
  const [hasNewResult, setHasNewResult] = useState(false);
  const [analysisLogs, setAnalysisLogs] = useState<AnalysisLogEntry[]>([]);

  const completeAnalysis = useCallback((r: PitchResult, logs: AnalysisLogEntry[]) => {
    setAnalysisLogs(logs);
    setResultState(r);

    // Ensure created_at is set
    const withTs: PitchResult = r.created_at
      ? r
      : { ...r, created_at: new Date().toISOString() };
    saveResultToHistory(withTs);
    setHasNewResult(true);

    const si = r.speed_info || {};
    const xn = si.plate_x_norm;
    const yn = si.plate_y_norm;
    if (xn == null || yn == null) return;
    if (xn < -0.5 || xn > 1.5 || yn < -0.5 || yn > 1.5) return;
    setSessionPitches((prev) => {
      if (prev.some((p) => p.job_id === r.job_id)) return prev;
      return [
        ...prev,
        {
          job_id: r.job_id,
          plate_x_norm: xn,
          plate_y_norm: yn,
          pitch_type: si.pitch_type || null,
          speed_kmh: si.release_speed_kmh ?? si.initial_speed_kmh ?? null,
          horizontal_break_cm: si.horizontal_break_cm ?? null,
          induced_vertical_break_cm: si.induced_vertical_break_cm ?? null,
          trajectory_points_norm: r.trajectory_points_norm,
        },
      ];
    });
  }, []);

  const clearPitches = useCallback(() => {
    setSessionPitches([]);
  }, []);

  const clearNewResultFlag = useCallback(() => {
    setHasNewResult(false);
  }, []);

  return (
    <ResultContext.Provider
      value={{
        result,
        sessionPitches,
        completeAnalysis,
        clearPitches,
        hasNewResult,
        clearNewResultFlag,
        analysisLogs,
      }}
    >
      {children}
    </ResultContext.Provider>
  );
}

export function useResult() {
  return useContext(ResultContext);
}
