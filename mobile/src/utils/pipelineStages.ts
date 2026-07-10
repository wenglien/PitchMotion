export interface Stage {
  id: string;
  icon: string;
  label: string;
  sublabel: string;
  color: string;
}

export const STAGES: Stage[] = [
  { id: 'init', icon: '🤖', label: '載入 AI 模型', sublabel: '初始化本機球偵測模型', color: '#8b5cf6' },
  { id: 'detection', icon: '🔍', label: '偵測棒球', sublabel: '逐幀掃描球的位置', color: '#0ea5e9' },
  { id: 'tracking', icon: '📍', label: '追蹤球路軌跡', sublabel: '分析飛行路徑與方向', color: '#10b981' },
  { id: 'speed', icon: '⚡', label: '計算球速', sublabel: '物理模型推算釋球速度', color: '#f59e0b' },
  { id: 'pitch_type', icon: '🎯', label: '辨識球種', sublabel: '快速球 / 變速球 / 曲球 / 滑球', color: '#ef4444' },
  { id: 'overlay', icon: '🎬', label: '生成分析影片', sublabel: '繪製軌跡並輸出影片', color: '#6366f1' },
  { id: 'done', icon: '✅', label: '分析完成', sublabel: '', color: '#059669' },
];

export function stageIndex(stageId: string): number {
  return STAGES.findIndex((stage) => stage.id === stageId);
}
