import { useState, useEffect } from "react";
import { fetchHistory, clearHistory } from "../api";

const KMH_TO_MPH = 0.621371;

function toDateKey(iso) {
  if (!iso) return "Unknown";
  try {
    const d = new Date(iso);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}/${m}/${day}`;
  } catch { return "Unknown"; }
}

function groupIntoSessions(records) {
  const map = {};
  for (const r of records) {
    const key = toDateKey(r.created_at);
    if (!map[key]) map[key] = [];
    map[key].push(r);
  }
  return Object.entries(map)
    .sort(([a], [b]) => (a > b ? -1 : 1))
    .map(([dateLabel, recs]) => ({
      dateLabel,
      records: [...recs].sort((a, b) =>
        new Date(b.created_at || 0) - new Date(a.created_at || 0)
      ),
    }));
}

function getSpeedKmh(r) {
  const si = r.speed_info || {};
  return si.release_speed_kmh ?? si.initial_speed_kmh ?? null;
}

export default function HistoryPage({ onSelectSession }) {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState("");

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await fetchHistory(200);
      setSessions(groupIntoSessions(data));
    } catch (e) {
      setError(e.message || "Failed to load history");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const onClearAll = async () => {
    if (!window.confirm("確定要清除伺服器上的所有投球紀錄嗎？此動作無法復原。")) return;
    try {
      await clearHistory();
      setSessions([]);
    } catch (e) {
      setError(e.message || "清除失敗");
    }
  };

  return (
    <div>
      <div className="page-header" style={{ justifyContent: "space-between" }}>
        <span>History</span>
        <button className="btn btn-ghost" onClick={load} disabled={loading}>
          {loading
            ? <span className="spinner" style={{ width: 16, height: 16, borderWidth: 2 }} />
            : "↻"}
        </button>
      </div>

      {sessions.length > 0 && (
        <div className="history-list-header">
          <span className="history-list-header-text">{sessions.length} 次練習</span>
          <button type="button" className="history-clear-all" onClick={onClearAll}>
            清除全部
          </button>
        </div>
      )}

      {error && (
        <p className="status-msg error" style={{ marginTop: 16 }}>{error}</p>
      )}

      {loading && sessions.length === 0 && (
        <div style={{ textAlign: "center", padding: "60px 24px", color: "var(--text-muted)" }}>
          <span className="spinner" />
          <p style={{ marginTop: 16 }}>Loading sessions…</p>
        </div>
      )}

      {!loading && sessions.length === 0 && !error && (
        <div style={{ textAlign: "center", padding: "60px 24px", color: "var(--text-muted)" }}>
          <p style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>尚無投球紀錄</p>
          <p style={{ fontSize: 14, marginTop: 8, lineHeight: 1.6 }}>
            完成第一次分析後，紀錄會自動儲存在這裡。
          </p>
        </div>
      )}

      <div className="history-list">
        {sessions.map((session, index) => {
          const { dateLabel, records } = session;
          const speeds = records
            .map(getSpeedKmh)
            .filter((v) => v !== null);
          const avgMph = speeds.length
            ? ((speeds.reduce((a, b) => a + b, 0) / speeds.length) * KMH_TO_MPH).toFixed(1)
            : null;
          const maxMph = speeds.length
            ? (Math.max(...speeds) * KMH_TO_MPH).toFixed(1)
            : null;

          const types = Array.from(
            new Set(
              records
                .map((r) => r.speed_info?.pitch_type)
                .filter((t) => !!t && t !== "Unknown"),
            ),
          ).slice(0, 3);

          return (
            <div
              key={dateLabel}
              className={`history-session-card${index === 0 ? " history-session-card--first" : ""}`}
              onClick={() => onSelectSession(session)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectSession(session);
                }
              }}
            >
              <div className="history-card-header">
                <span className="history-card-date">{dateLabel}</span>
                <span className="history-card-arrow">›</span>
              </div>
              <div className="history-stats-row">
                <div className="history-stat">
                  <div className="history-stat-val">{records.length}</div>
                  <div className="history-stat-lbl">投球</div>
                </div>
                {avgMph !== null && (
                  <div className="history-stat">
                    <div className="history-stat-val">{avgMph}</div>
                    <div className="history-stat-lbl">均速 mph</div>
                  </div>
                )}
                {maxMph !== null && (
                  <div className="history-stat">
                    <div className="history-stat-val history-stat-val--accent">{maxMph}</div>
                    <div className="history-stat-lbl">最高 mph</div>
                  </div>
                )}
              </div>
              {types.length > 0 && (
                <div className="history-type-row">
                  {types.map((t) => (
                    <span key={t} className="history-type-chip">{t}</span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
