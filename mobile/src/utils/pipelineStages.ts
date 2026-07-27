import type { NativeProgressEvent } from '../../modules/expo-speedgun';

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

export interface PipelineProgressState {
  stageId: string;
  message: string;
  pct: number;
}

const STAGE_MAP: Record<string, string> = {
  init: 'init',
  decode: 'init',
  setup: 'init',
  detection: 'detection',
  detecting: 'detection',
  gap_fill: 'detection',
  tracking: 'tracking',
  calculating: 'speed',
  speed: 'speed',
  pitch_type: 'pitch_type',
  overlay: 'overlay',
  done: 'done',
};

const DEFAULT_MESSAGES: Record<string, string> = {
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

export function normalizePipelineProgress(event: NativeProgressEvent): PipelineProgressState {
  const stageId = STAGE_MAP[event.stage] || event.stage;
  const message = event.message || DEFAULT_MESSAGES[event.stage] || '處理中…';
  let pct: number;

  switch (stageId) {
    case 'init':
      pct = Math.round(event.progress * 5);
      break;
    case 'detection':
      pct = 5 + Math.round(event.progress * 40);
      break;
    case 'tracking':
      pct = 45 + Math.round(event.progress * 15);
      break;
    case 'speed':
      pct = 60 + Math.round(event.progress * 5);
      break;
    case 'pitch_type':
      pct = 65 + Math.round(event.progress * 5);
      break;
    case 'overlay':
      pct = 70 + Math.round(event.progress * 28);
      break;
    case 'done':
      pct = 100;
      break;
    default:
      pct = Math.round(event.progress * 100);
  }

  return { stageId, message, pct: Math.min(pct, 100) };
}
