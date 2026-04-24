import { useState } from "react";
import { checkHealth } from "../api";

export default function SettingsPage({ settings, onChange }) {
  const set = (key, val) => onChange({ ...settings, [key]: val });

  const isOffline = settings.analysisMode === "offline";

  const [moundText, setMoundText] = useState(
    settings.moundDistanceM > 0 ? String(settings.moundDistanceM) : "",
  );
  const [strideText, setStrideText] = useState(String(settings.strideCorrectionM ?? 0));
  const [confText, setConfText] = useState(String(settings.confThreshold ?? 0.05));
  const [pitcherHeightText, setPitcherHeightText] = useState(
    settings.pitcherHeightM != null ? String(settings.pitcherHeightM) : "",
  );
  const [backendText, setBackendText] = useState(settings.backendUrl || "");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const sz = settings.strikeZone || {};
  const [zxMinText, setZxMinText] = useState(sz.xMin != null ? String(sz.xMin) : "");
  const [zxMaxText, setZxMaxText] = useState(sz.xMax != null ? String(sz.xMax) : "");
  const [zyMinText, setZyMinText] = useState(sz.yMin != null ? String(sz.yMin) : "");
  const [zyMaxText, setZyMaxText] = useState(sz.yMax != null ? String(sz.yMax) : "");

  const commitStrikeZone = () => {
    const parse = (s) => {
      const n = parseFloat(s);
      return Number.isFinite(n) ? n : NaN;
    };
    const xMin = parse(zxMinText);
    const xMax = parse(zxMaxText);
    const yMin = parse(zyMinText);
    const yMax = parse(zyMaxText);
    const allBlank = [zxMinText, zxMaxText, zyMinText, zyMaxText]
      .every((s) => s.trim() === "");
    if (allBlank) {
      set("strikeZone", null);
      return;
    }
    const valid =
      [xMin, xMax, yMin, yMax].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) &&
      xMin < xMax && yMin < yMax;
    if (valid) {
      set("strikeZone", { xMin, xMax, yMin, yMax });
    }
  };

  const resetStrikeZone = () => {
    setZxMinText("");
    setZxMaxText("");
    setZyMinText("");
    setZyMaxText("");
    set("strikeZone", null);
  };

  const onTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    const trimmed = backendText.trim();
    const ok = await checkHealth(trimmed || undefined);
    setTestResult(ok);
    setTesting(false);
    if (ok) set("backendUrl", trimmed);
  };

  return (
    <div>
      <div className="page-header">Settings</div>

      <div className="card" style={{ marginTop: 12 }}>
        <h3 className="settings-section-title">Analysis Mode</h3>
        <div className="settings-mode-row">
          <button
            type="button"
            className={`settings-mode-btn${isOffline ? " settings-mode-btn--active" : ""}`}
            onClick={() => set("analysisMode", "offline")}
          >
            <span className="settings-mode-icon">📱</span>
            <span className="settings-mode-label">離線模式</span>
            <span className="settings-mode-desc">裝置端 AI 運算</span>
          </button>
          <button
            type="button"
            className={`settings-mode-btn${!isOffline ? " settings-mode-btn--active" : ""}`}
            onClick={() => set("analysisMode", "online")}
          >
            <span className="settings-mode-icon">☁️</span>
            <span className="settings-mode-label">線上模式</span>
            <span className="settings-mode-desc">上傳至伺服器</span>
          </button>
        </div>
        <p className="settings-mode-hint">
          {isOffline
            ? "瀏覽器版無法執行離線 AI 分析。請切換為「線上模式」後上傳影片至後端。"
            : "將影片上傳至後端伺服器分析，需要網路連線。"}
        </p>
      </div>

      {!isOffline && (
        <div className="card">
          <h3 className="settings-section-title">Server Connection</h3>
          <div className="field">
            <label>Backend URL</label>
            <input
              type="url"
              value={backendText}
              onChange={(e) => setBackendText(e.target.value)}
              onBlur={() => {
                const v = backendText.trim();
                setBackendText(v);
                set("backendUrl", v);
              }}
              placeholder="留空 = 使用開發代理 (Vite) 或 VITE_API_BASE_URL"
              autoCapitalize="off"
              autoCorrect="off"
            />
            <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.6 }}>
              本機開發可留空。遠端裝置請填 Mac 區網 IP 或 ngrok，例如 http://192.168.1.5:8000
            </p>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            style={{ height: 44, marginTop: 4 }}
            disabled={testing}
            onClick={onTestConnection}
          >
            {testing ? "Testing…" : "Test Connection"}
          </button>
          {testResult !== null && (
            <p style={{
              fontSize: 14,
              fontWeight: 600,
              textAlign: "center",
              marginTop: 8,
              color: testResult ? "var(--green)" : "var(--red)",
            }}>
              {testResult ? "✓ Connected successfully" : "✗ Connection failed"}
            </p>
          )}
        </div>
      )}

      <div className="card">
        <h3 className="settings-section-title">Analysis Parameters</h3>

        <div className="field">
          <label>投打距離 Pitcher→Home Plate (m)</label>
          <input
            type="text"
            inputMode="decimal"
            placeholder="請量測實際距離（例如 7.0）"
            value={moundText}
            onChange={(e) => setMoundText(e.target.value)}
            onBlur={() => {
              const n = parseFloat(moundText);
              const val = Number.isNaN(n) || n < 0 ? 0 : n;
              setMoundText(val > 0 ? String(val) : "");
              set("moundDistanceM", val);
            }}
          />
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.6 }}>
            ⚠️ <strong>此數值直接決定球速準度</strong>，請務必實際量測。<br />
            MLB 18.44m · 高中 ~16m · 少棒 ~14m · 後院練投 5–10m<br />
            留空 / 填 0 = 伺服器自動估算
          </p>
        </div>

        <div className="field">
          <label>投手身高 Pitcher Height (m，選填)</label>
          <input
            type="text"
            inputMode="decimal"
            placeholder="例如 1.75"
            value={pitcherHeightText}
            onChange={(e) => setPitcherHeightText(e.target.value)}
            onBlur={() => {
              const n = parseFloat(pitcherHeightText);
              if (!Number.isNaN(n) && n > 1 && n < 2.4) {
                setPitcherHeightText(String(n));
                set("pitcherHeightM", n);
              } else {
                setPitcherHeightText("");
                set("pitcherHeightM", undefined);
              }
            }}
          />
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.6 }}>
            若留空會用肩寬估距；填入身高時對側身姿勢較穩。（後端支援時會一併送出）
          </p>
        </div>

        <div className="field">
          <label>Stride Correction (metres)</label>
          <input
            type="text"
            inputMode="decimal"
            value={strideText}
            onChange={(e) => setStrideText(e.target.value)}
            onBlur={() => {
              const n = parseFloat(strideText);
              const val = Number.isNaN(n) ? 0 : n;
              setStrideText(String(val));
              set("strideCorrectionM", val);
            }}
          />
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            投手跨步距離（公尺），從投球距離中扣除以提升準確度，不確定請填 0
          </p>
        </div>

        <div className="field">
          <label>Detection Confidence Threshold</label>
          <input
            type="text"
            inputMode="decimal"
            value={confText}
            onChange={(e) => setConfText(e.target.value)}
            onBlur={() => {
              const n = parseFloat(confText);
              const val = Number.isNaN(n) || n <= 0 ? 0.03 : n;
              setConfText(String(val));
              set("confThreshold", val);
            }}
          />
          <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
            Lower = more detections but more noise. Recommended: 0.03–0.10.
          </p>
        </div>
      </div>

      <div className="card">
        <h3 className="settings-section-title">好球帶校準 Strike Zone Calibration</h3>
        <p style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, marginBottom: 10, lineHeight: 1.6 }}>
          依相機角度微調好球帶的畫面座標（0–1，以影片顯示尺寸為準，直立 iPhone 為例）。<br />
          <strong>x</strong>：左右邊界（0=畫面最左，1=畫面最右）<br />
          <strong>y</strong>：上下邊界（0=畫面最上，1=畫面最下）<br />
          預設值：x 0.33–0.67，y 0.56–0.86。全部留空 = 使用預設。
        </p>

        <div className="field" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <div>
            <label>x_min</label>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.33"
              value={zxMinText}
              onChange={(e) => setZxMinText(e.target.value)}
              onBlur={commitStrikeZone}
            />
          </div>
          <div>
            <label>x_max</label>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.67"
              value={zxMaxText}
              onChange={(e) => setZxMaxText(e.target.value)}
              onBlur={commitStrikeZone}
            />
          </div>
          <div>
            <label>y_min</label>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.56"
              value={zyMinText}
              onChange={(e) => setZyMinText(e.target.value)}
              onBlur={commitStrikeZone}
            />
          </div>
          <div>
            <label>y_max</label>
            <input
              type="text"
              inputMode="decimal"
              placeholder="0.86"
              value={zyMaxText}
              onChange={(e) => setZyMaxText(e.target.value)}
              onBlur={commitStrikeZone}
            />
          </div>
        </div>

        <button
          type="button"
          className="btn"
          style={{ height: 40, marginTop: 8 }}
          onClick={resetStrikeZone}
        >
          重置為預設
        </button>

        {settings.strikeZone && (
          <p style={{ fontSize: 12, color: "var(--green)", marginTop: 8 }}>
            ✓ 已套用自訂好球帶：x {settings.strikeZone.xMin}–{settings.strikeZone.xMax}，
            y {settings.strikeZone.yMin}–{settings.strikeZone.yMax}
          </p>
        )}
      </div>

      <div className="card">
        <h3 className="settings-section-title">About</h3>
        <p style={{ fontSize: 14, color: "var(--text-muted)", lineHeight: 1.7 }}>
          <strong style={{ color: "var(--text)" }}>SpeedGun</strong>
          <br />AI-powered baseball pitch speed analyser.
          <br />
          {isOffline
            ? "Select a video → on-device AI analysis → instant speed readout."
            : "Upload a video → get instant mph / km/h readout."}
          <br /><br />
          Powered by YOLO ball detection, body pose estimation,
          and a physics-based speed calculator.
        </p>
      </div>
    </div>
  );
}
