import { useState, useEffect } from "react";
import StrikeZone from "../components/StrikeZone";
import BreakChart from "../components/BreakChart";

const KMH_TO_MPH = 0.621371;
function kmhToMph(kmh) { return (kmh * KMH_TO_MPH).toFixed(1); }

const PITCH_COLORS = {
  Fastball:    "#4f8ef7",
  "Four-Seam": "#4f8ef7",
  Curveball:   "#f5c542",
  Slider:      "#f07a5a",
  Changeup:    "#22d3a5",
  Sinker:      "#9b7cfc",
  Cutter:      "#f05aa5",
  Splitter:    "#22c0d3",
};
function pitchColor(type) { return PITCH_COLORS[type] || "#7c5cfc"; }

function shortMethod(m) {
  if (!m) return "";
  if (m.toLowerCase().includes("theoretical")) return "Theory";
  if (m.toLowerCase().includes("pixel"))       return "Pixel";
  if (m.toLowerCase().includes("kalman"))      return "Kalman";
  return m;
}

let _sessionPitches = [];

export default function ResultPage({ result, onUploadAnother }) {
  const [sessionPitches, setSessionPitches] = useState(_sessionPitches);
  const [overlayError, setOverlayError]     = useState(false);
  const [overlayNonce, setOverlayNonce]     = useState(0);

  useEffect(() => {
    if (!result) return;
    const si = result.speed_info || {};
    if (si.plate_x_norm == null && si.plate_y_norm == null) return;
    const alreadyAdded = _sessionPitches.some(p => p.job_id === result.job_id);
    if (!alreadyAdded) {
      _sessionPitches = [
        ..._sessionPitches,
        {
          job_id:       result.job_id,
          plate_x_norm: si.plate_x_norm,
          plate_y_norm: si.plate_y_norm,
          pitch_type:   si.pitch_type || null,
          speed_kmh:    si.release_speed_kmh ?? si.initial_speed_kmh ?? null,
        },
      ];
      setSessionPitches([..._sessionPitches]);
    }
  }, [result]);

  if (!result) {
    return (
      <div>
        <div className="page-header">Result</div>
        <div style={{ textAlign: "center", padding: "60px 24px", color: "var(--text-muted)" }}>
          <p style={{ fontSize: 16 }}>No analysis yet.</p>
          <p style={{ fontSize: 14, marginTop: 8 }}>
            Upload a video to see your pitch speed and trajectory.
          </p>
          {onUploadAnother && (
            <button
              className="btn btn-primary"
              style={{ marginTop: 20, maxWidth: 260 }}
              onClick={onUploadAnother}
            >
              Go to Upload
            </button>
          )}
        </div>
      </div>
    );
  }

  const si         = result.speed_info || {};
  const primaryKmh = si.release_speed_kmh ?? si.initial_speed_kmh ?? null;
  const primaryMph = primaryKmh !== null ? kmhToMph(primaryKmh) : null;
  const maxKmh     = si.max_speed_kmh ?? null;
  const distM      = si.total_distance_m ?? si.effective_distance_m ?? null;
  const flightS    = si.flight_time_s   ?? null;
  const breakH          = si.horizontal_break_cm ?? null;
  const breakVInduced   = si.induced_vertical_break_cm ?? null;
  const breakTotal      = si.total_break_cm ?? null;
  const breakConf       = si.break_confidence ?? null;
  const hasBreakChart   = breakH !== null && breakVInduced !== null;

  const physClamped = si.physics_clamped ?? false;
  const pitchType   = si.pitch_type && si.pitch_type !== "Unknown" ? si.pitch_type : null;
  const pitchConf   = si.pitch_confidence ? Math.round(si.pitch_confidence * 100) : null;
  const method      = shortMethod(si.calculation_method);
  const hasWarn     = !!si.trajectory_quality_warning;

  const overlayUrl  = result.overlay_url
    ? result.overlay_url.replace(/^https?:\/\/[^/]+/, "")
    : null;
  const originalUrl = result.original_url
    ? result.original_url.replace(/^https?:\/\/[^/]+/, "")
    : null;

  const plateZone  = si.plate_zone ?? null;
  const zoneOverride = plateZone
    ? { xMin: plateZone.x_min, xMax: plateZone.x_max, yMin: plateZone.y_min, yMax: plateZone.y_max }
    : null;

  const hasDetectionInfo = (
    result.yolo_ball_in_frame_count !== undefined ||
    result.yolo_frames_processed   !== undefined ||
    result.total_frames            !== undefined ||
    result.trajectory_count        !== undefined
  );

  return (
    <div>
      <div className="page-header">Result</div>

      {/* ── Hero Card ─────────────────────────────── */}
      <div className="hero-card">
        {pitchType && (
          <div className="hero-badge-row">
            <span className="pitch-badge" style={{ background: pitchColor(pitchType) }}>
              {pitchType}
            </span>
            {pitchConf !== null && (
              <span className="hero-conf-text">{pitchConf}% confidence</span>
            )}
          </div>
        )}

        <div className="hero-speed-wrap">
          {primaryMph !== null ? (
            <>
              <span className="hero-speed-num">{primaryMph}</span>
              <span className="hero-speed-meta">
                <span className="hero-speed-unit">mph</span>
                <span className="hero-speed-kmh">
                  {primaryKmh?.toFixed(1)} km/h
                </span>
              </span>
            </>
          ) : (
            <span className="hero-speed-na">Speed unavailable</span>
          )}
        </div>

        <div className="hero-divider" />

        <div className="hero-stats-row">
          <div className="hero-stat">
            <div className="hero-stat-val">{maxKmh !== null ? kmhToMph(maxKmh) : "—"}</div>
            <div className="hero-stat-lbl">Max mph</div>
          </div>
          <div className="hero-stat-divider" />
          <div className="hero-stat">
            <div className="hero-stat-val">{distM !== null ? distM.toFixed(1) : "—"}</div>
            <div className="hero-stat-lbl">Dist m</div>
          </div>
          <div className="hero-stat-divider" />
          <div className="hero-stat">
            <div className="hero-stat-val">{flightS !== null ? flightS.toFixed(3) : "—"}</div>
            <div className="hero-stat-lbl">Flight s</div>
          </div>
        </div>

        <div className="hero-chip-row">
          {method && (
            <span className="method-chip">{method}</span>
          )}
          {hasWarn && (
            <span className="warn-chip">Trajectory warning</span>
          )}
          {physClamped && (
            <span className="warn-chip">Estimated velocity</span>
          )}
        </div>
      </div>

      {/* ── Strike Zone ───────────────────────────── */}
      <div className="card" style={{ marginTop: 10 }}>
        <div className="result-card-header">
          <span className="result-card-title">Pitch Location</span>
          <span className="result-card-sub">
            Session · {sessionPitches.length} pitch{sessionPitches.length !== 1 ? "es" : ""}
          </span>
        </div>
        <div className="result-card-divider" />
        <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
          <StrikeZone pitches={sessionPitches} zoneOverride={zoneOverride} />
        </div>
        {sessionPitches.length > 0 && (
          <button
            className="btn btn-ghost"
            style={{
              marginTop: 10,
              width: "100%",
              justifyContent: "center",
              fontSize: 13,
              color: "var(--accent)",
              fontWeight: 600,
            }}
            onClick={() => { _sessionPitches = []; setSessionPitches([]); }}
          >
            Clear pitch log
          </button>
        )}
      </div>

      {/* ── Break Analysis ────────────────────────── */}
      {hasBreakChart && (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="result-card-header">
            <span className="result-card-title">Break Analysis</span>
            <span className="result-card-sub">Pitch movement</span>
          </div>
          <div className="result-card-divider" />

          <div className="kine-block">
            <div className="kine-header-row">
              <span className="kine-section-title">Break (cm)</span>
              {breakConf !== null && (
                <span className="kine-conf-pill">
                  {Math.round(breakConf * 100)}% conf
                </span>
              )}
            </div>
            <div className="break-chart-wrap">
              <BreakChart
                horizontalCm={breakH}
                inducedVerticalCm={breakVInduced}
                pitchType={pitchType}
                confidence={breakConf ?? 0.6}
              />
            </div>
            {breakTotal !== null && (
              <div className="break-total-hint">
                Total break{" "}
                <span className="break-total-val">{breakTotal.toFixed(1)}</span> cm
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Overlay Video ─────────────────────────── */}
      {overlayUrl && !overlayUrl.startsWith("/dev/") && (
        <div className="video-card">
          <div className="video-card-header">
            <span className="result-card-title">Analysis Video</span>
            <a
              href={overlayUrl.replace("/overlays/", "/download/")}
              download
              className="download-btn"
            >
              ⬇ Save
            </a>
          </div>
          {overlayError ? (
            <div className="video-fallback">
              <p style={{ fontSize: 14, color: "var(--text)", marginBottom: 10 }}>
                ⚠️ Overlay video failed to load
              </p>
              <p style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14, lineHeight: 1.5 }}>
                Try reloading or use Save above to open it locally.
              </p>
              <button
                className="btn btn-secondary"
                style={{ height: 36, padding: "0 18px", fontSize: 13 }}
                onClick={() => { setOverlayError(false); setOverlayNonce(n => n + 1); }}
              >
                ↻ Retry
              </button>
            </div>
          ) : (
            <video
              key={`${overlayUrl}-${overlayNonce}`}
              className="video-preview"
              src={overlayUrl}
              controls
              playsInline
              style={{ maxHeight: 260 }}
              onError={() => setOverlayError(true)}
            />
          )}
          <p className="video-hint">
            若畫面為黑或無法播放，請點 Retry 或 Save 下載後用本機播放器開啟。
          </p>
        </div>
      )}

      {/* ── Original Video ────────────────────────── */}
      {originalUrl && (
        <div className="video-card">
          <span className="result-card-title">Original Recording</span>
          <div style={{ height: 8 }} />
          <video
            key={originalUrl}
            className="video-preview"
            src={originalUrl}
            controls
            playsInline
            style={{ maxHeight: 260 }}
          />
        </div>
      )}

      {/* ── Detection Details ─────────────────────── */}
      {hasDetectionInfo && (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="result-card-header">
            <span className="result-card-title">Detection Details</span>
          </div>
          <div className="result-card-divider" />
          <div className="detail-grid">
            <div className="detail-row">
              <span className="detail-label">Total frames</span>
              <span className="detail-value">{result.total_frames ?? "—"}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">YOLO frames processed</span>
              <span className="detail-value">{result.yolo_frames_processed ?? "—"}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Frames with ball</span>
              <span
                className="detail-value"
                style={{
                  color:
                    result.yolo_raw_detection_frames > 0
                      ? "var(--green)"
                      : result.yolo_raw_detection_frames === 0
                        ? "var(--red)"
                        : "var(--text)",
                }}
              >
                {result.yolo_raw_detection_frames ?? "—"}
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">YOLO detections</span>
              <span className="detail-value">{result.yolo_total_detections ?? "—"}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Ball in frame (Phase1)</span>
              <span
                className="detail-value"
                style={{
                  color:
                    result.yolo_ball_in_frame_count > 0
                      ? "var(--green)"
                      : result.yolo_ball_in_frame_count === 0
                        ? "var(--red)"
                        : "var(--text)",
                }}
              >
                {result.yolo_ball_in_frame_count ?? "—"}
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Trajectory points</span>
              <span className="detail-value">{result.trajectory_count ?? "—"}</span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Resolution</span>
              <span className="detail-value">
                {result.video_width && result.video_height
                  ? `${result.video_width}×${result.video_height}`
                  : "—"}
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">FPS</span>
              <span className="detail-value">{result.fps ?? "—"}</span>
            </div>
          </div>
        </div>
      )}

      {/* ── CTA ───────────────────────────────────── */}
      <div style={{ padding: "16px 16px 24px" }}>
        <button
          className="btn btn-primary"
          style={{ width: "100%" }}
          onClick={onUploadAnother}
        >
          Analyse Another Pitch
        </button>
      </div>
    </div>
  );
}
