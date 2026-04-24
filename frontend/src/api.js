const ENV_BASE = import.meta.env.VITE_API_BASE_URL || "";

/** When set, all API calls use this origin (no trailing slash). Empty = relative URLs (Vite proxy). */
let customBase = "";

export function setApiBaseUrl(url) {
  customBase = (url || "").trim().replace(/\/$/, "");
}

function base() {
  if (customBase) return customBase;
  return ENV_BASE.replace(/\/$/, "");
}

function apiUrl(path) {
  const p = path.startsWith("/") ? path : `/${path}`;
  const b = base();
  return b ? `${b}${p}` : p;
}

export function checkFileSize(file, maxMB = 50) {
  const maxBytes = maxMB * 1024 * 1024;
  if (file.size > maxBytes) {
    throw new Error(
      `影片檔案過大（${(file.size / 1024 / 1024).toFixed(1)} MB）。\n` +
        `請先在手機上壓縮至 ${maxMB} MB 以內，或使用較短的片段。`
    );
  }
  return file;
}

export function uploadVideo(videoFile, opts = {}, onUploadProgress) {
  const {
    moundDistanceM    = 0,
    strideCorrectionM = 0,
    confThreshold     = 0.05,
    strikeZone        = null,
  } = opts;

  const form = new FormData();
  form.append("video",               videoFile);
  form.append("mound_distance_m",    String(moundDistanceM));
  form.append("stride_correction_m", String(strideCorrectionM));
  form.append("conf_threshold",      String(confThreshold));

  if (
    strikeZone &&
    [strikeZone.xMin, strikeZone.xMax, strikeZone.yMin, strikeZone.yMax].every(
      (n) => typeof n === "number" && Number.isFinite(n),
    ) &&
    strikeZone.xMin < strikeZone.xMax &&
    strikeZone.yMin < strikeZone.yMax
  ) {
    form.append("zone_x_min", String(strikeZone.xMin));
    form.append("zone_x_max", String(strikeZone.xMax));
    form.append("zone_y_min", String(strikeZone.yMin));
    form.append("zone_y_max", String(strikeZone.yMax));
  }

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", apiUrl("/analyze"));

    if (onUploadProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable)
          onUploadProgress(Math.round((e.loaded / e.total) * 100));
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject(new Error("伺服器回傳格式錯誤")); }
      } else {
        let msg = `伺服器錯誤 ${xhr.status}`;
        try { msg = JSON.parse(xhr.responseText).detail || msg; } catch { }
        reject(new Error(msg));
      }
    };
    xhr.onerror   = () => reject(new Error("網路錯誤，請確認連線後重試。"));
    xhr.ontimeout = () => reject(new Error("上傳逾時，請稍後再試。"));
    xhr.timeout   = 3 * 60 * 1000;
    xhr.send(form);
  });
}

export function streamLogs(jobId, onLog) {
  const url = apiUrl(`/logs/${jobId}`);
  const es = new EventSource(url);

  es.onmessage = (e) => {
    try {
      const entry = JSON.parse(e.data);
      onLog(entry);
      if (entry.level === "DONE") {
        es.close();
      }
    } catch { }
  };

  es.onerror = () => {
    onLog({ level: "WARN", message: "Log 連線中斷", ts: new Date().toISOString() });
    es.close();
  };

  return () => es.close();
}

export function waitForJob(jobId, { intervalMs = 1500, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const poll = async () => {
      if (Date.now() > deadline) {
        return reject(new Error("分析逾時，請稍後再試。"));
      }
      try {
        const res = await fetch(apiUrl(`/jobs/${jobId}`));
        if (!res.ok) return reject(new Error(`Job status error: ${res.status}`));
        const info = await res.json();

        if (info.status === "done")  return resolve(info.result);
        if (info.status === "error") return reject(new Error(info.error || "分析失敗"));

        setTimeout(poll, intervalMs);
      } catch (err) {
        reject(err);
      }
    };

    setTimeout(poll, intervalMs);
  });
}

export function analyzeVideo(videoFile, opts = {}, onProgress, onLog) {
  return new Promise(async (resolve, reject) => {
    try {
      const { job_id } = await uploadVideo(videoFile, opts, (pct) => {
        if (onProgress) onProgress(pct);
      });

      let cancelLog = null;
      if (onLog) {
        cancelLog = streamLogs(job_id, onLog);
      }

      try {
        const result = await waitForJob(job_id);
        resolve(result);
      } finally {
        if (cancelLog) cancelLog();
      }
    } catch (err) {
      reject(err);
    }
  });
}

export async function fetchHistory(limit = 20) {
  const res = await fetch(apiUrl(`/history?limit=${limit}`));
  if (!res.ok) throw new Error("Failed to fetch history");
  const data = await res.json();
  return data.records ?? [];
}

export async function clearHistory() {
  const res = await fetch(apiUrl("/history"), { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to clear history");
  return res.json().catch(() => ({}));
}

export async function checkHealth(overrideBase) {
  try {
    const url = overrideBase != null && String(overrideBase).trim()
      ? `${String(overrideBase).trim().replace(/\/$/, "")}/health`
      : apiUrl("/health");
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}
