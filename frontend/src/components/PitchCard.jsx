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
function pitchColor(type) {
  return PITCH_COLORS[type] || "#7c5cfc";
}

function formatTime(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch { return ""; }
}

function formatDate(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric", month: "2-digit", day: "2-digit",
    });
  } catch { return ""; }
}

export function generateCoachingComment(si) {
  if (!si) return "Keep working on consistency and mechanics.";

  const mph = si.release_speed_kmh
    ? si.release_speed_kmh * KMH_TO_MPH
    : si.initial_speed_kmh
      ? si.initial_speed_kmh * KMH_TO_MPH
      : null;
  const type = si.pitch_type;
  const parts = [];

  if (mph !== null) {
    if      (mph < 45) parts.push("Focus on building arm strength to increase velocity.");
    else if (mph < 55) parts.push("Work on increasing velocity for more effectiveness.");
    else if (mph < 65) parts.push("Decent velocity. Focus on consistent mechanics.");
    else if (mph < 80) parts.push("Good velocity range. Work on command.");
    else               parts.push("Strong pitch velocity.");
  }

  if (!parts[1]) {
    if (type === "Fastball" || type === "Four-Seam") {
      parts.push("Maintain consistent four-seam grip for maximum ride.");
    } else if (type === "Curveball") {
      parts.push("Focus on consistent release point for a sharp break.");
    } else if (type === "Slider") {
      parts.push("Ensure a clean cut at release for sharp horizontal movement.");
    } else if (type === "Changeup") {
      parts.push("Keep arm speed consistent to disguise the changeup effectively.");
    } else if (type === "Cutter") {
      parts.push("Small wrist-side pressure at release creates the cut movement.");
    } else if (type === "Sinker") {
      parts.push("Drive your fingers over the top to generate downward action.");
    }
  }

  return parts.length > 0
    ? parts.slice(0, 2).join(" ")
    : "Keep working on consistency and mechanics.";
}

function shortMethod(m) {
  if (!m) return "—";
  if (m.toLowerCase().includes("theoretical")) return "Theory";
  if (m.toLowerCase().includes("pixel"))       return "Pixel";
  if (m.toLowerCase().includes("kalman"))      return "Kalman";
  return m.slice(0, 6);
}

export default function PitchCard({ pitch, index }) {
  const si = pitch?.speed_info || {};

  const vMph     = si.release_speed_kmh
    ? kmhToMph(si.release_speed_kmh)
    : si.initial_speed_kmh
      ? kmhToMph(si.initial_speed_kmh)
      : null;
  const maxMph   = si.max_speed_kmh  ? kmhToMph(si.max_speed_kmh)  : null;
  const distM    = si.total_distance_m ?? si.effective_distance_m ?? null;
  const flightS  = si.flight_time_s  ?? null;
  const confPct  = si.pitch_confidence != null
    ? Math.round(si.pitch_confidence * 100)
    : null;
  const method   = shortMethod(si.calculation_method);
  const hasWarn  = !!si.trajectory_quality_warning;
  const pitchType = si.pitch_type && si.pitch_type !== "Unknown" ? si.pitch_type : null;
  const comment   = generateCoachingComment(si);

  const cells = [
    { label: "V",      value: vMph    ?? "—", unit: "mph"  },
    { label: "Max",    value: maxMph  ?? "—", unit: "mph"  },
    { label: "Dist",   value: distM   != null ? distM.toFixed(1) : "—", unit: "m" },
    { label: "Flight", value: flightS != null ? flightS.toFixed(3) : "—", unit: "s" },
    { label: "Conf",   value: confPct != null ? `${confPct}%` : "—", unit: "" },
    { label: "Method", value: method, unit: "", small: true },
    { label: "Quality",value: hasWarn ? "⚠️" : "✓", unit: "", color: hasWarn ? "var(--yellow)" : "var(--green)" },
  ];

  return (
    <div className="pitch-card">
      <div className="pitch-card-header">
        <div>
          <div className="pch-timestamp">
            {formatDate(pitch?.created_at)} {formatTime(pitch?.created_at)}
          </div>
          <div className="pch-num">
            {index}. Pitch
          </div>
        </div>
        {pitchType && (
          <span
            className="pitch-type-badge"
            style={{ background: pitchColor(pitchType) }}
          >
            {pitchType}
          </span>
        )}
      </div>

      <div className="pitch-stat-grid">
        {cells.map((c) => (
          <div className="pitch-stat-cell" key={c.label}>
            <div className="psc-label">{c.label}</div>
            <div
              className="psc-value"
              style={{
                fontSize: c.small ? 12 : undefined,
                color: c.color || undefined,
              }}
            >
              {c.value}
            </div>
            {c.unit && <div className="psc-unit">{c.unit}</div>}
          </div>
        ))}
      </div>

      <div className="pitch-comment">
        <div className="pc-header">
          <span className="pc-icon">⚾️</span>
          <span className="pc-label">Comment</span>
        </div>
        <div className="pc-body">
          {comment}
        </div>
      </div>
    </div>
  );
}
