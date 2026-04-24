export interface Stage {
  id: string;
  icon: string;
  label: string;
  sublabel: string;
  color: string;
}

export interface ParsedLog {
  stageId: string | null;
  userMsg: string;
  isError?: boolean;
}

export const STAGES: Stage[] = [
  { id: 'upload', icon: '☁️', label: '上傳影片', sublabel: '傳送到分析伺服器', color: '#3b82f6' },
  { id: 'init', icon: '🤖', label: '載入 AI 模型', sublabel: '初始化 YOLO 球偵測模型', color: '#8b5cf6' },
  { id: 'detection', icon: '🔍', label: '偵測棒球', sublabel: '逐幀掃描球的位置', color: '#0ea5e9' },
  { id: 'tracking', icon: '📍', label: '追蹤球路軌跡', sublabel: '分析飛行路徑與方向', color: '#10b981' },
  { id: 'speed', icon: '⚡', label: '計算球速', sublabel: '物理模型推算釋球速度', color: '#f59e0b' },
  { id: 'pitch_type', icon: '🎯', label: '辨識球種', sublabel: '快速球 / 變速球 / 曲球 / 滑球', color: '#ef4444' },
  { id: 'overlay', icon: '🎬', label: '生成 Overlay 影片', sublabel: '繪製軌跡並輸出影片', color: '#6366f1' },
  { id: 'done', icon: '✅', label: '分析完成', sublabel: '', color: '#059669' },
];

export function parseLog(rawMsg: string): ParsedLog | null {
  if (!rawMsg) return null;

  const msg = rawMsg.replace(/^[\w.]+\s*[–-]\s*/, '').trim();

  if (/Loading.*YOLO model/i.test(msg))
    return { stageId: 'init', userMsg: '載入 YOLO 球偵測模型…' };

  if (/球速計算.*投手丘距離/i.test(msg)) {
    const m = msg.match(/投手丘距離=([\d.]+)m/);
    const dist = m ? `${parseFloat(m[1]).toFixed(1)} m` : '';
    return { stageId: 'init', userMsg: `設定投手丘距離：${dist}` };
  }

  if (/球種判定：使用/i.test(msg))
    return { stageId: 'init', userMsg: '初始化球種分類器…' };

  if (/Processing Video/i.test(msg))
    return { stageId: 'detection', userMsg: '開始讀取影片幀…' };

  if (/Phase 1.*VideoCapture/i.test(msg))
    return { stageId: 'detection', userMsg: '啟動影片解碼器…' };

  if (/Phase 1.*pre-rotated|Video rotation detected/i.test(msg)) {
    const m = msg.match(/(\d+)x(\d+)/g);
    return { stageId: 'detection', userMsg: m ? `影片解析度：${m[0]} → ${m[1] || m[0]}` : '偵測影片方向…' };
  }

  if (/Phase 1 complete.*(\d+) frames/i.test(msg)) {
    const m = msg.match(/(\d+) frames/);
    return { stageId: 'detection', userMsg: m ? `掃描完成：${m[1]} 幀` : '掃描完成' };
  }

  if (/Static FP filter.*removed (\d+)/i.test(msg)) {
    const m = msg.match(/removed (\d+)/);
    return { stageId: 'detection', userMsg: m ? `過濾背景雜訊：移除 ${m[1]} 個假陽性` : '過濾背景雜訊…' };
  }

  if (/Phase 1\.5.*gap.fill.*recovered (\d+)/i.test(msg)) {
    const m = msg.match(/recovered (\d+)/);
    return { stageId: 'detection', userMsg: m ? `補幀修復：補回 ${m[1]} 個遺失幀` : '修復遺失偵測…' };
  }

  if (/Track selection.*(\d+) tracks/i.test(msg)) {
    const m = msg.match(/(\d+) tracks/);
    return { stageId: 'tracking', userMsg: m ? `分析 ${m[1]} 條候選軌跡…` : '分析軌跡…' };
  }

  if (/Selected Track (\d+)/i.test(msg))
    return { stageId: 'tracking', userMsg: '鎖定最佳球路軌跡 ✓' };

  if (/No valid track found/i.test(msg))
    return { stageId: 'tracking', userMsg: '⚠️ 未找到有效球路，嘗試備用方案…' };

  if (/Backward track extension/i.test(msg))
    return { stageId: 'tracking', userMsg: '延伸軌跡至釋球瞬間…' };

  if (/Catch.*point recorded/i.test(msg))
    return { stageId: 'tracking', userMsg: '偵測到接球位置 ✓' };

  if (/Release point.*trajectory|Release point.*pose/i.test(msg))
    return { stageId: 'tracking', userMsg: '計算釋球點位置 ✓' };

  if (/Audio catch.*frame (\d+)/i.test(msg)) {
    const m = msg.match(/frame (\d+)/);
    return { stageId: 'tracking', userMsg: m ? `音訊偵測到接球聲（幀 ${m[1]}）` : '音訊偵測接球聲…' };
  }

  if (/Audio catch.*no.*audio|Audio catch unavailable/i.test(msg))
    return { stageId: 'tracking', userMsg: '無音訊，改用視覺偵測接球…' };

  if (/Pitch location/i.test(msg)) {
    const strike = msg.includes('is_strike=True');
    return { stageId: 'tracking', userMsg: strike ? '判定：好球 ✓' : '判定：壞球' };
  }

  if (/Theoretical calc.*mound/i.test(msg))
    return { stageId: 'speed', userMsg: '啟動物理模型計算…' };

  if (/Flight time:.*frames.*s\)/i.test(msg)) {
    const m = msg.match(/([\d.]+)s\)/);
    return { stageId: 'speed', userMsg: m ? `飛行時間：${parseFloat(m[1]).toFixed(3)} 秒` : '計算飛行時間…' };
  }

  if (/Speed calc.*release.*km\/h/i.test(msg)) {
    const m = msg.match(/release\(v0\)=([\d.]+) km\/h/);
    return { stageId: 'speed', userMsg: m ? `球速：${parseFloat(m[1]).toFixed(1)} km/h ⚡` : '計算釋球速度…' };
  }

  if (/Trajectory linearity RMSE/i.test(msg)) {
    const ok = msg.includes('(OK)');
    return { stageId: 'speed', userMsg: ok ? '軌跡線性度良好 ✓' : '⚠️ 軌跡有些許雜訊，速度可能略有誤差' };
  }

  if (/Flight time.*clamping|exceeds.*cap/i.test(msg))
    return { stageId: 'speed', userMsg: '⚠️ 套用物理上下限修正' };

  if (/Spin RPM.*speed-based/i.test(msg)) {
    const m = msg.match(/([\d.]+) RPM/);
    return { stageId: 'speed', userMsg: m ? `轉速估算：${m[1]} RPM` : '估算球的轉速…' };
  }

  if (/Speed results.*release/i.test(msg)) {
    const km = msg.match(/release=([\d.]+)km\/h/);
    const rpm = msg.match(/rpm=([\d.]+)/);
    const parts: string[] = [];
    if (km) parts.push(`${parseFloat(km[1]).toFixed(1)} km/h`);
    if (rpm) parts.push(`${rpm[1]} RPM`);
    return { stageId: 'speed', userMsg: parts.length ? `結果：${parts.join('・')} ✓` : '速度計算完成 ✓' };
  }

  if (/球種判定：[^使用]/.test(msg)) {
    const m = msg.match(/球種判定：(\S+)（信心=(\d+)%）/);
    if (m) return { stageId: 'pitch_type', userMsg: `辨識結果：${m[1]}（信心 ${m[2]}%）✓` };
    if (/軌跡點不足/.test(msg))
      return { stageId: 'pitch_type', userMsg: '⚠️ 球路資料不足，跳過球種辨識' };
    return { stageId: 'pitch_type', userMsg: '球種辨識中…' };
  }

  if (/Overlay output scale/i.test(msg)) {
    const m = msg.match(/(\d+x\d+)/g);
    return { stageId: 'overlay', userMsg: m ? `輸出解析度：${m[m.length - 1]}` : '準備生成 Overlay…' };
  }

  if (/Saving overlay result/i.test(msg))
    return { stageId: 'overlay', userMsg: '開始繪製球路軌跡…' };

  if (/ffmpeg pipe encoder.*audio_mux/i.test(msg)) {
    const hasAudio = msg.includes('True');
    return { stageId: 'overlay', userMsg: hasAudio ? '編碼影片（含音訊）…' : '編碼影片…' };
  }

  if (/Overlay fade-in.*catch_frame/i.test(msg))
    return { stageId: 'overlay', userMsg: '繪製軌跡曲線與速度標注…' };

  if (/ffmpeg pipe encoder finished/i.test(msg))
    return { stageId: 'overlay', userMsg: '影片編碼完成 ✓' };

  if (/Overlay 影片已輸出|overlay.*已輸出/i.test(msg))
    return { stageId: 'done', userMsg: '分析完成！' };

  if (/⚡.*開始分析/.test(msg))
    return { stageId: 'init', userMsg: msg };

  if (/error|failed|失敗/i.test(rawMsg) && !/low displacement/i.test(rawMsg))
    return { stageId: null, userMsg: msg, isError: true };

  if (
    /Track \d+: (pts=|disp=|reject|skip|size-growth|centre bonus)/i.test(msg) ||
    /NORM_RECT|XNNPACK|inference_feedback|gl_context|feedback manager/i.test(msg) ||
    /Phase 2: Applying/i.test(msg)
  ) return null;

  return null;
}

export function stageIndex(stageId: string): number {
  return STAGES.findIndex((s) => s.id === stageId);
}
