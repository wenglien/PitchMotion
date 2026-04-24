import { Session } from '../types';

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
