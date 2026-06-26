import { PitchResult, Session } from '../types';

export type RootStackParamList = {
  MainTabs: undefined;
  TrajectorySimulation: { pitch: PitchResult; title?: string };
};

export type BottomTabParamList = {
  Analyze: undefined;
  Result: undefined;
  History: undefined;
  Settings: undefined;
};

export type HistoryStackParamList = {
  HistoryList: undefined;
  SessionDetail: { session: Session };
};
