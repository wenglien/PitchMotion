import { useState } from "react";
import PitchCard, { generateCoachingComment } from "../components/PitchCard";
import StrikeZone from "../components/StrikeZone";

const KMH_TO_MPH = 0.621371;

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

function getSpeedKmh(r) {
  const si = r.speed_info || {};
  return si.release_speed_kmh ?? si.initial_speed_kmh ?? null;
}

function buildTypeStats(records) {
  const map = {};
  for (const r of records) {
    const si    = r.speed_info || {};
    const type  = si.pitch_type && si.pitch_type !== "Unknown" ? si.pitch_type : "Unknown";
    const kmh   = getSpeedKmh(r);
    if (!map[type]) map[type] = { count: 0, speedsKmh: [] };
    map[type].count += 1;
    if (kmh != null) map[type].speedsKmh.push(kmh);
  }
  return Object.entries(map)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([type, d]) => ({
      type,
      count: d.count,
      avgMph: d.speedsKmh.length
        ? (d.speedsKmh.reduce((a, b) => a + b, 0) / d.speedsKmh.length * KMH_TO_MPH).toFixed(1)
        : null,
      color: pitchColor(type),
    }));
}

function toStrikeZonePitches(records) {
  return records
    .filter((r) => {
      const si = r.speed_info || {};
      return si.plate_x_norm != null && si.plate_y_norm != null;
    })
    .map((r) => {
      const si = r.speed_info || {};
      return {
        job_id:       r.job_id,
        plate_x_norm: si.plate_x_norm,
        plate_y_norm: si.plate_y_norm,
        pitch_type:   si.pitch_type || null,
        speed_kmh:    getSpeedKmh(r),
      };
    });
}

function generateSessionSummary(records) {
  const speeds = records
    .map(getSpeedKmh)
    .filter(Boolean)
    .map((kmh) => kmh * KMH_TO_MPH);

  const avgMph = speeds.length
    ? (speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(1)
    : null;
  const maxMph = speeds.length ? Math.max(...speeds).toFixed(1) : null;

  const typeCounts = {};
  records.forEach((r) => {
    const t = r.speed_info?.pitch_type;
    if (t && t !== "Unknown") typeCounts[t] = (typeCounts[t] || 0) + 1;
  });
  const topType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0];

  const lines = [
    `本次練習共 ${records.length} 球。`,
    avgMph ? `平均球速 ${avgMph} mph，最高 ${maxMph} mph。` : null,
    topType ? `主要球種：${topType[0]}（${topType[1]} 球）。` : null,
  ].filter(Boolean);

  if (avgMph !== null) {
    if (parseFloat(avgMph) < 50) {
      lines.push("可加強肌力與投球機制以提升球速。");
    } else if (parseFloat(avgMph) < 65) {
      lines.push("業餘水準不錯，建議加強控球與變化球。");
    } else {
      lines.push("球速表現良好，持續精進控球與配球。");
    }
  }

  return lines.join(" ");
}

const TAB_LIST = "投球列表";
const TAB_GRAPH = "軌跡圖";
const TAB_AI = "AI 建議";
const TABS = [TAB_LIST, TAB_GRAPH, TAB_AI];

function ListTab({ records }) {
  if (records.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "48px 24px", color: "var(--text-muted)" }}>
        <p>此次練習無投球紀錄。</p>
      </div>
    );
  }

  return (
    <div style={{ paddingTop: 8, paddingBottom: 16 }}>
      {records.map((r, i) => (
        <PitchCard
          key={r.job_id || i}
          pitch={r}
          index={records.length - i}
        />
      ))}
    </div>
  );
}

function GraphTab({ records }) {
  const pitches   = toStrikeZonePitches(records);
  const typeStats = buildTypeStats(records);
  const pz = records.find((r) => r.speed_info?.plate_zone)?.speed_info?.plate_zone;
  const zoneOverride = pz
    ? { xMin: pz.x_min, xMax: pz.x_max, yMin: pz.y_min, yMax: pz.y_max }
    : null;

  return (
    <div style={{ paddingBottom: 24 }}>
      <div className="card" style={{ marginTop: 12 }}>
        <div className="result-card-header">
          <span className="result-card-title">好球帶落點</span>
        </div>
        <div className="result-card-sub" style={{ marginTop: 4 }}>
          {pitches.length} 球已標記
        </div>
        <div className="result-card-divider" />
        <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
          <StrikeZone pitches={pitches} zoneOverride={zoneOverride} />
        </div>
      </div>

      {typeStats.length > 0 && (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="result-card-header">
            <span className="result-card-title">球種分佈</span>
          </div>
          <div className="result-card-divider" />
          <table className="pitch-stats-table session-type-table">
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>球種</th>
                <th>數量</th>
                <th>均速</th>
              </tr>
            </thead>
            <tbody>
              {typeStats.map(({ type, count, avgMph, color }) => (
                <tr key={type}>
                  <td>
                    <div className="pst-type">
                      <span className="pst-dot" style={{ background: color }} />
                      {type}
                    </div>
                  </td>
                  <td>{count}</td>
                  <td>{avgMph !== null ? `${avgMph} mph` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AICoachTab({ records }) {
  const speeds = records
    .map(getSpeedKmh)
    .filter(Boolean)
    .map((kmh) => kmh * KMH_TO_MPH);

  const avgMph = speeds.length
    ? (speeds.reduce((a, b) => a + b, 0) / speeds.length).toFixed(1)
    : null;
  const maxMph = speeds.length ? Math.max(...speeds).toFixed(1) : null;

  const summary = generateSessionSummary(records);

  return (
    <div style={{ paddingBottom: 24 }}>
      <div className="ai-coach-stats" style={{ margin: "12px 16px 0" }}>
        <div className="ai-coach-stat">
          <div className="acs-label">投球數</div>
          <div className="acs-value">{records.length}</div>
        </div>
        <div className="ai-coach-stat">
          <div className="acs-label">均速 mph</div>
          <div className="acs-value">{avgMph ?? "—"}</div>
        </div>
        <div className="ai-coach-stat">
          <div className="acs-label">最高 mph</div>
          <div className="acs-value" style={{ color: "var(--accent)" }}>{maxMph ?? "—"}</div>
        </div>
      </div>

      <div className="card" style={{ margin: "12px 16px 0" }}>
        <div className="result-card-header">
          <span className="result-card-title">AI 投球建議</span>
        </div>
        <div className="result-card-sub" style={{ marginTop: 4 }}>本次練習分析</div>
        <div className="result-card-divider" />
        <p style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.65, marginTop: 8 }}>
          {summary}
        </p>
      </div>

      {records.length > 0 && (
        <div style={{ margin: "0 16px" }}>
          <div className="session-highlights-label">最近投球重點</div>
          {records.slice(0, 5).map((r, i) => {
            const si = r.speed_info || {};
            const comment = generateCoachingComment(si);
            const type = si.pitch_type && si.pitch_type !== "Unknown" ? si.pitch_type : null;
            const mph = si.release_speed_kmh
              ? (si.release_speed_kmh * KMH_TO_MPH).toFixed(1)
              : si.initial_speed_kmh
                ? (si.initial_speed_kmh * KMH_TO_MPH).toFixed(1)
                : null;
            return (
              <div key={r.job_id || i} className="session-highlight-item">
                <span
                  className="session-highlight-num"
                  style={{ background: type ? pitchColor(type) : "var(--surface2)" }}
                >
                  {records.length - i}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="session-highlight-meta">
                    {mph !== null && <span className="session-highlight-speed">{mph} mph</span>}
                    {type && <span className="session-highlight-type">{type}</span>}
                  </div>
                  <p className="session-highlight-comment">{comment}</p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function SessionDetailPage({ session, onBack }) {
  const [activeTab, setActiveTab] = useState(TAB_LIST);
  const { dateLabel, records } = session;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="session-detail-header">
        <button type="button" className="sdh-back" onClick={onBack}>
          ‹ 返回
        </button>
        <div className="sdh-title-block">
          <span className="sdh-title">{dateLabel}</span>
          <span className="sdh-count">{records.length} 球</span>
        </div>
        <div className="sdh-spacer" />
      </div>

      <div className="seg-tabs">
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            className={`seg-tab${activeTab === t ? " active" : ""}`}
            onClick={() => setActiveTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: "auto" }}>
        {activeTab === TAB_LIST && <ListTab records={records} />}
        {activeTab === TAB_GRAPH && <GraphTab records={records} />}
        {activeTab === TAB_AI && <AICoachTab records={records} />}
      </div>
    </div>
  );
}
