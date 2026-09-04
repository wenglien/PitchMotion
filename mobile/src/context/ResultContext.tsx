import React, { createContext, useContext, useState, useCallback } from 'react';
import { Alert } from 'react-native';
import { PitchResult } from '../types';
import { saveResultToHistory } from '../hooks/useLocalHistory';

export interface AnalysisLogEntry {
  msg: string;
  isError: boolean;
}

interface ResultContextValue {
  result: PitchResult | null;
  sessionResults: PitchResult[];
  completeAnalysis: (result: PitchResult, logs: AnalysisLogEntry[]) => void;
  clearPitches: () => void;
  hasNewResult: boolean;
  clearNewResultFlag: () => void;
  analysisLogs: AnalysisLogEntry[];
}

const ResultContext = createContext<ResultContextValue>({
  result: null,
  sessionResults: [],
  completeAnalysis: () => {},
  clearPitches: () => {},
  hasNewResult: false,
  clearNewResultFlag: () => {},
  analysisLogs: [],
});

export function ResultProvider({ children }: { children: React.ReactNode }) {
  const [result, setResultState] = useState<PitchResult | null>(null);
  const [sessionResults, setSessionResults] = useState<PitchResult[]>([]);
  const [hasNewResult, setHasNewResult] = useState(false);
  const [analysisLogs, setAnalysisLogs] = useState<AnalysisLogEntry[]>([]);

  const completeAnalysis = useCallback((r: PitchResult, logs: AnalysisLogEntry[]) => {
    setAnalysisLogs(logs);
    const withTs: PitchResult = r.created_at
      ? r
      : { ...r, created_at: new Date().toISOString() };
    setResultState(withTs);
    const save = () => {
      saveResultToHistory(withTs).catch(() => Alert.alert(
        '分析完成，但紀錄尚未儲存',
        '本次結果仍可在結果頁查看。請確認裝置儲存空間後重試。',
        [{ text: '稍後', style: 'cancel' }, { text: '重試儲存', onPress: save }],
      ));
    };
    save();
    setHasNewResult(true);

    setSessionResults((prev) => {
      if (prev.some((pitch) => pitch.job_id === withTs.job_id)) return prev;
      return [...prev, withTs];
    });
  }, []);

  const clearPitches = useCallback(() => {
    setSessionResults([]);
  }, []);

  const clearNewResultFlag = useCallback(() => {
    setHasNewResult(false);
  }, []);

  return (
    <ResultContext.Provider
      value={{
        result,
        sessionResults,
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
