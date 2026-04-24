import { useState, useRef, useCallback, useEffect } from "react";
import { analyzeVideo, checkFileSize } from "../api";
import { STAGES, parseLog, stageIndex } from "../utils/pipelineStages";

const MAX_MB = 50;

function AnalysisProgress({ uploadPct, stageId, stageMessages, rawLogs, showRaw }) {
  const currentIdx = stageIndex(stageId || "upload");
  const logEndRef  = useRef(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [stageMessages]);

  const lastMsg = stageMessages[stageMessages.length - 1] || "";

  return (
    <div className="analysis-card">
      <div className="analysis-header">
        <ProgressRing
          pct={uploadPct < 100 ? uploadPct : Math.round(((currentIdx + 0.5) / STAGES.length) * 100)}
          isUpload={uploadPct < 100}
          stageColor={STAGES[Math.max(0, currentIdx)]?.color}
        />
        <div className="analysis-header-text">
          <div className="analysis-title">
            {uploadPct < 100 ? "上傳影片中" : (STAGES[currentIdx]?.label ?? "分析中")}
          </div>
          <div className="analysis-subtitle">
            {uploadPct < 100
              ? `${uploadPct}% 已上傳`
              : (lastMsg || STAGES[currentIdx]?.sublabel || "處理中…")}
          </div>
        </div>
      </div>

      <div className="stage-list">
        {STAGES.slice(0, -1).map((stage, i) => {
          const state =
            i < currentIdx  ? "done"
            : i === currentIdx ? "active"
            : "pending";

          return (
            <div key={stage.id} className={`stage-row stage-${state}`}>
              <div className="stage-icon-col">
                <div className="stage-icon-wrap" style={{ "--stage-color": stage.color }}>
                  {state === "done" ? (
                    <span className="stage-check">✓</span>
                  ) : state === "active" ? (
                    <span className="stage-spinner" />
                  ) : (
                    <span className="stage-emoji">{stage.icon}</span>
                  )}
                </div>
                {i < STAGES.length - 2 && <div className={`stage-line ${state === "done" ? "done" : ""}`} />}
              </div>

              <div className="stage-text">
                <div className="stage-label">{stage.label}</div>
                {state === "active" && lastMsg && (
                  <div className="stage-detail">{lastMsg}</div>
                )}
                {state === "done" && (
                  <div className="stage-detail done-text">完成</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showRaw && rawLogs.length > 0 && (
        <div className="raw-log-section">
          <div className="raw-log-body">
            {rawLogs.map((entry, i) => (
              <div key={i} className={`raw-log-line ${entry.isError ? "raw-error" : ""}`}>
                {entry.msg}
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>
      )}
    </div>
  );
}

function ProgressRing({ pct, isUpload, stageColor }) {
  const R   = 26;
  const C   = 2 * Math.PI * R;
  const off = C - (pct / 100) * C;

  return (
    <div className="progress-ring-wrap">
      <svg width="68" height="68" viewBox="0 0 68 68">
        <circle cx="34" cy="34" r={R} fill="none" stroke="#e5e7eb" strokeWidth="5" />
        <circle
          cx="34" cy="34" r={R}
          fill="none"
          stroke={isUpload ? "#3b82f6" : (stageColor || "#2563eb")}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={off}
          transform="rotate(-90 34 34)"
          style={{ transition: "stroke-dashoffset .6s ease, stroke .4s" }}
        />
      </svg>
      <div className="progress-ring-pct">{pct}%</div>
    </div>
  );
}

export default function UploadPage({ settings, onResult }) {
  const isOffline = settings.analysisMode === "offline";
  const [file,          setFile]         = useState(null);
  const [previewUrl,    setPreviewUrl]    = useState(null);
  const [dragging,      setDragging]      = useState(false);
  const [analyzing,     setAnalyzing]     = useState(false);
  const [uploadPct,     setUploadPct]     = useState(0);
  const [currentStage,  setCurrentStage]  = useState(null);
  const [stageMessages, setStageMessages] = useState([]);
  const [rawLogs,       setRawLogs]       = useState([]);
  const [showRaw,       setShowRaw]       = useState(false);
  const [statusMsg,     setStatusMsg]     = useState("");
  const [statusType,    setStatusType]    = useState("");
  const fileInputRef = useRef(null);

  const resetAnalysis = () => {
    setUploadPct(0);
    setCurrentStage(null);
    setStageMessages([]);
    setRawLogs([]);
    setShowRaw(false);
  };

  const handleFile = useCallback((f) => {
    if (!f) return;
    try { checkFileSize(f, MAX_MB); }
    catch (e) {
      setStatusMsg(e.message);
      setStatusType("error");
      return;
    }
    setFile(f);
    resetAnalysis();
    setStatusMsg(`✓ ${f.name}  (${(f.size / 1024 / 1024).toFixed(1)} MB)`);
    setStatusType("success");
    setPreviewUrl(URL.createObjectURL(f));
  }, []);

  const onInputChange = (e) => handleFile(e.target.files?.[0]);
  const onDragOver  = (e) => { e.preventDefault(); setDragging(true); };
  const onDragLeave = ()  => setDragging(false);
  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files?.[0]);
  };

  const onAnalyze = async () => {
    if (!file || analyzing || isOffline) return;
    setAnalyzing(true);
    resetAnalysis();
    setStatusMsg("");
    setStatusType("");

    try {
      const result = await analyzeVideo(
        file,
        {
          moundDistanceM:    settings.moundDistanceM,
          strideCorrectionM: settings.strideCorrectionM,
          confThreshold:     settings.confThreshold,
          strikeZone:        settings.strikeZone,
        },
        (pct) => {
          setUploadPct(pct);
          if (pct >= 100) setCurrentStage("init");
        },
        (entry) => {
          if (entry.level === "DONE") return;

          const raw = entry.message || "";

          const parsed = parseLog(raw);
          if (parsed) {
            if (parsed.stageId) {
              setCurrentStage(parsed.stageId);
            }
            if (!parsed.isError) {
              setStageMessages((prev) => {
                const last = prev[prev.length - 1];
                if (last === parsed.userMsg) return prev;
                return [...prev.slice(-20), parsed.userMsg];
              });
            }
          }

          if (raw && !/NORM_RECT|XNNPACK|inference_feedback|gl_context/.test(raw)) {
            const cleanMsg = raw.replace(/^[\w.]+\s*[–-]\s*/, "").trim();
            setRawLogs((prev) => [...prev.slice(-200), {
              msg: cleanMsg,
              isError: entry.level === "ERROR",
            }]);
          }
        }
      );

      setCurrentStage("done");
      setStatusMsg("分析完成！");
      setStatusType("success");
      onResult(result, file);
    } catch (err) {
      setStatusMsg(err.message || "分析失敗。");
      setStatusType("error");
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div>
      <div className="page-header">SpeedGun</div>

      {isOffline && (
        <div className="card" style={{
          margin: "12px 16px 0",
          borderColor: "var(--yellow)",
          background: "rgba(217, 119, 6, 0.06)",
        }}>
          <p style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6, margin: 0 }}>
            目前為「離線模式」。<strong>網頁版需在設定中切換為「線上模式」</strong>才能上傳並分析影片。
          </p>
        </div>
      )}

      {analyzing ? (
        <div style={{ marginTop: 16 }}>
          <AnalysisProgress
            uploadPct={uploadPct}
            stageId={currentStage}
            stageMessages={stageMessages}
            rawLogs={rawLogs}
            showRaw={showRaw}
          />

          <button
            className="raw-log-toggle"
            onClick={() => setShowRaw((v) => !v)}
          >
            {showRaw ? "▲ 隱藏技術詳情" : "▼ 查看技術詳情"}
          </button>
        </div>
      ) : (
        <>
          <div
            className={`drop-zone${dragging ? " drag-over" : ""}`}
            style={{ marginTop: 16 }}
            onClick={() => fileInputRef.current?.click()}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
          >
            <div className="icon" />
            <div className="title">
              {file ? "Video selected" : "Select pitch video"}
            </div>
            <div className="subtitle">
              {file ? "Tap to change file" : `Tap to choose or drag\nMax ${MAX_MB} MB`}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              style={{ display: "none" }}
              onChange={onInputChange}
            />
          </div>

          {previewUrl && (
            <div className="card" style={{ padding: 8, marginTop: 8 }}>
              <video className="video-preview" src={previewUrl} controls muted playsInline />
            </div>
          )}

          {statusMsg && (
            <p className={`status-msg${statusType ? " " + statusType : ""}`}>
              {statusMsg}
            </p>
          )}

          <div className="card" style={{ marginTop: 12 }}>
            <p style={{ fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
              <strong style={{ color: "var(--text)" }}>Tips for best results</strong>
              <br />• Film from behind the pitcher or catcher at eye level
              <br />• Use slow-motion mode (120fps+) if available
              <br />• Ensure good lighting and a clear background
              <br />• Keep the full pitching motion in frame
            </p>
          </div>
        </>
      )}

      <div style={{ padding: "16px 16px 0" }}>
        <button
          className="btn btn-primary"
          disabled={!file || analyzing || isOffline}
          onClick={onAnalyze}
        >
          {analyzing ? (
            <><span className="spinner" role="status" aria-label="Analysis in progress" /> Analysing…</>
          ) : (
            "Analyse Pitch Speed"
          )}
        </button>
      </div>
    </div>
  );
}
