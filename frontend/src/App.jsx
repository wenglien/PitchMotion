import { useState, useCallback, useEffect, useRef } from "react";
import UploadPage from "./pages/UploadPage";
import ResultPage from "./pages/ResultPage";
import HistoryPage from "./pages/HistoryPage";
import SessionDetailPage from "./pages/SessionDetailPage";
import SettingsPage from "./pages/SettingsPage";
import TabBar from "./components/TabBar";
import { setApiBaseUrl, fetchHistory } from "./api";
import "./App.css";

const POLL_INTERVAL_MS = 3000;

export default function App() {
  const [activeTab, setActiveTab]         = useState("upload");
  const [result, setResult]               = useState(null);
  const [sessionDetail, setSessionDetail] = useState(null);
  const [settings, setSettings]           = useState({
    moundDistanceM:    0,
    strideCorrectionM: 0,
    confThreshold:     0.05,
    analysisMode:      "online",
    backendUrl:        "",
    pitcherHeightM:    undefined,
    // Strike-zone calibration in display-normalised coords (0-1).
    // null = use backend defaults; set via SettingsPage to override per camera setup.
    strikeZone:        null,
  });
  const lastJobIdRef = useRef(null);
  const timerRef     = useRef(null);

  useEffect(() => {
    setApiBaseUrl(settings.backendUrl || "");
  }, [settings.backendUrl]);

  const switchTab = useCallback((tab) => {
    setActiveTab(tab);
    if (tab !== "history") setSessionDetail(null);
  }, []);

  const handleResult = useCallback((data) => {
    lastJobIdRef.current = data.job_id;
    setResult(data);
    setActiveTab("result");
  }, []);

  useEffect(() => {
    let active = true;

    const seed = async () => {
      try {
        const records = await fetchHistory(1);
        if (!active) return;
        const latest = records[0];
        if (latest && lastJobIdRef.current === null) {
          lastJobIdRef.current = latest.job_id;
        }
      } catch { /* ignore */ }
    };

    seed().then(() => {
      if (!active) return;
      const poll = async () => {
        try {
          const records = await fetchHistory(1);
          const latest = records[0];
          if (!latest) return;
          if (latest.job_id !== lastJobIdRef.current) {
            lastJobIdRef.current = latest.job_id;
            setResult(latest);
            setActiveTab("result");
          }
        } catch { /* ignore */ }
      };

      const timer = setInterval(poll, POLL_INTERVAL_MS);
      timerRef.current = timer;
    });

    return () => {
      active = false;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return (
    <div className="app-shell">
      <div className="page-area">
        {activeTab === "upload" && (
          <UploadPage settings={settings} onResult={handleResult} />
        )}
        {activeTab === "result" && (
          <ResultPage result={result} onUploadAnother={() => switchTab("upload")} />
        )}
        {activeTab === "history" && !sessionDetail && (
          <HistoryPage
            onSelectSession={(s) => setSessionDetail(s)}
          />
        )}
        {activeTab === "history" && sessionDetail && (
          <SessionDetailPage
            session={sessionDetail}
            onBack={() => setSessionDetail(null)}
          />
        )}
        {activeTab === "settings" && (
          <SettingsPage settings={settings} onChange={setSettings} />
        )}
      </div>
      <TabBar active={activeTab} onSelect={switchTab} />
    </div>
  );
}
