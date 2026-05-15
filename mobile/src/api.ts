import EventSource from 'react-native-sse';
import { PitchResult, StrikeZoneCalibration } from './types';
import { UserCancelledError } from './utils/errors';

/** Returned by analyzeVideo so the caller (UI) can cancel an in-flight job. */
export interface AnalyzeHandle {
  promise: Promise<PitchResult>;
  cancel: () => void;
}

export function checkFileSize(fileSize: number, maxMB = 50) {
  const maxBytes = maxMB * 1024 * 1024;
  if (fileSize > maxBytes) {
    throw new Error(
      `影片檔案過大（${(fileSize / 1024 / 1024).toFixed(1)} MB）。\n` +
      `請先在手機上壓縮至 ${maxMB} MB 以內，或使用較短的片段。`
    );
  }
}

export function uploadVideo(
  baseUrl: string,
  videoUri: string,
  fileName: string,
  opts: {
    moundDistanceM?: number;
    strideCorrectionM?: number;
    confThreshold?: number;
    strikeZone?: StrikeZoneCalibration | null;
    signal?: AbortSignal;
  } = {},
  onUploadProgress?: (pct: number) => void,
): Promise<{ job_id: string }> {
  if (!baseUrl || baseUrl.trim() === '') {
    return Promise.reject(new Error(
      '尚未設定 Backend URL。請到「Settings → Backend URL」輸入伺服器位址，或將「Analysis Mode」切換為「離線分析」。'
    ));
  }
  const {
    moundDistanceM = 18.44,
    strideCorrectionM = 0,
    confThreshold = 0.03,
    strikeZone = null,
    signal,
  } = opts;

  const form = new FormData();
  form.append('video', {
    uri: videoUri,
    name: fileName || 'video.mp4',
    type: 'video/mp4',
  } as any);
  form.append('mound_distance_m', String(moundDistanceM));
  form.append('stride_correction_m', String(strideCorrectionM));
  form.append('conf_threshold', String(confThreshold));
  if (
    strikeZone &&
    [strikeZone.xMin, strikeZone.xMax, strikeZone.yMin, strikeZone.yMax].every(
      (n) => typeof n === 'number' && Number.isFinite(n),
    ) &&
    strikeZone.xMin < strikeZone.xMax &&
    strikeZone.yMin < strikeZone.yMax
  ) {
    form.append('zone_x_min', String(strikeZone.xMin));
    form.append('zone_x_max', String(strikeZone.xMax));
    form.append('zone_y_min', String(strikeZone.yMin));
    form.append('zone_y_max', String(strikeZone.yMax));
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${baseUrl}/analyze`);

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try { xhr.abort(); } catch {}
      reject(new UserCancelledError('已取消上傳'));
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort);
    }
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    if (onUploadProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          onUploadProgress(Math.round((e.loaded / e.total) * 100));
      };
    }

    xhr.onload = () => {
      cleanup();
      if (aborted) return;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error('伺服器回傳格式錯誤'));
        }
      } else {
        let msg = `伺服器錯誤 ${xhr.status}`;
        try {
          msg = JSON.parse(xhr.responseText).detail || msg;
        } catch {}
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => {
      cleanup();
      if (!aborted) reject(new Error('網路錯誤，請確認連線後重試。'));
    };
    xhr.ontimeout = () => {
      cleanup();
      if (!aborted) reject(new Error('上傳逾時，請稍後再試。'));
    };
    xhr.timeout = 3 * 60 * 1000;
    xhr.send(form);
  });
}

export function streamLogs(
  baseUrl: string,
  jobId: string,
  onLog: (entry: { level: string; message: string; ts: string }) => void,
): () => void {
  const url = `${baseUrl}/logs/${jobId}`;
  const es = new EventSource(url);

  es.addEventListener('message', (event: any) => {
    try {
      const entry = JSON.parse(event.data);
      onLog(entry);
      if (entry.level === 'DONE') {
        es.close();
      }
    } catch {}
  });

  es.addEventListener('error', () => {
    onLog({ level: 'WARN', message: 'Log 連線中斷', ts: new Date().toISOString() });
    es.close();
  });

  return () => es.close();
}

export function waitForJob(
  baseUrl: string,
  jobId: string,
  { intervalMs = 1500, timeoutMs = 10 * 60 * 1000, signal }: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<PitchResult> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onAbort = () => {
      if (timer) clearTimeout(timer);
      reject(new UserCancelledError('已取消分析'));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort);
    }
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };

    const poll = async () => {
      if (signal?.aborted) return;
      if (Date.now() > deadline) {
        cleanup();
        return reject(new Error('分析逾時，請稍後再試。'));
      }
      try {
        const res = await fetch(`${baseUrl}/jobs/${jobId}`, { signal });
        if (!res.ok) {
          cleanup();
          return reject(new Error(`Job status error: ${res.status}`));
        }
        const info = await res.json();

        if (info.status === 'done') { cleanup(); return resolve(info.result); }
        if (info.status === 'error') { cleanup(); return reject(new Error(info.error || '分析失敗')); }

        timer = setTimeout(poll, intervalMs);
      } catch (err) {
        cleanup();
        reject(err);
      }
    };

    timer = setTimeout(poll, intervalMs);
  });
}

export async function analyzeVideo(
  baseUrl: string,
  videoUri: string,
  fileName: string,
  opts: {
    moundDistanceM?: number;
    strideCorrectionM?: number;
    confThreshold?: number;
    strikeZone?: StrikeZoneCalibration | null;
    signal?: AbortSignal;
  } = {},
  onProgress?: (pct: number) => void,
  onLog?: (entry: { level: string; message: string; ts: string }) => void,
): Promise<PitchResult> {
  const { signal, ...uploadOpts } = opts;

  const { job_id } = await uploadVideo(
    baseUrl,
    videoUri,
    fileName,
    { ...uploadOpts, signal },
    (pct) => { if (onProgress) onProgress(pct); },
  );

  let cancelLog: (() => void) | null = null;
  if (onLog) {
    cancelLog = streamLogs(baseUrl, job_id, onLog);
  }

  try {
    const result = await waitForJob(baseUrl, job_id, { signal });
    return result;
  } finally {
    if (cancelLog) cancelLog();
  }
}

export async function fetchHistory(baseUrl: string, limit = 20): Promise<PitchResult[]> {
  const res = await fetch(`${baseUrl}/history?limit=${limit}`);
  if (!res.ok) throw new Error('Failed to fetch history');
  const data = await res.json();
  return data.records ?? [];
}

export async function checkHealth(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(timeoutId);
    return res.ok;
  } catch {
    return false;
  }
}
