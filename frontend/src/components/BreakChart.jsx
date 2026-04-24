import { useMemo } from "react";

// ─── MLB-style two-axis break chart (Web port of mobile/BreakChart.tsx) ───
// Shows a single pitch as a coloured dot on a symmetric X/Y plot:
//   X axis = horizontal break (cm) — + right, − left
//   Y axis = induced vertical break (cm) — + rise, − drop (gravity removed)
//
// Props
//   horizontalCm        signed horizontal break in cm (+ = right)
//   inducedVerticalCm   signed induced vertical break in cm (+ = rise)
//   pitchType           optional label (drives dot colour)
//   confidence          optional 0..1 (faint halo radius)

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

const SIZE      = 240;
const PAD       = 28;
const AXIS_MIN  = 50;

function roundUpNice(v) {
  if (v <= 25)  return 25;
  if (v <= 50)  return 50;
  if (v <= 75)  return 75;
  if (v <= 100) return 100;
  return Math.ceil(v / 25) * 25;
}

export default function BreakChart({
  horizontalCm,
  inducedVerticalCm,
  pitchType,
  confidence,
}) {
  const dotColor = (pitchType && PITCH_COLORS[pitchType]) || "#4f8ef7";

  const axisHalf = useMemo(() => {
    const peak = Math.max(
      AXIS_MIN,
      Math.abs(horizontalCm) * 1.25,
      Math.abs(inducedVerticalCm) * 1.25,
    );
    return roundUpNice(peak);
  }, [horizontalCm, inducedVerticalCm]);

  const plot  = SIZE - PAD * 2;
  const cx    = PAD + plot / 2;
  const cy    = PAD + plot / 2;
  const scale = (plot / 2) / axisHalf;
  const dotX  = cx + horizontalCm * scale;
  const dotY  = cy - inducedVerticalCm * scale;

  const ringFractions = [0.25, 0.5, 0.75, 1.0];
  const tickFractions = [0.5, 1.0];

  const conf  = typeof confidence === "number"
    ? Math.max(0, Math.min(1, confidence))
    : 0.6;
  const haloR = 11 + (1 - conf) * 8;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <svg width={SIZE} height={SIZE} style={{ userSelect: "none" }} aria-label="Pitch break chart">
        <defs>
          <radialGradient id="bcBg" cx="50%" cy="50%" r="60%">
            <stop offset="0%"   stopColor="#f8fafc" stopOpacity="1" />
            <stop offset="100%" stopColor="#eef1f6" stopOpacity="1" />
          </radialGradient>
          <radialGradient id="bcDot" cx="30%" cy="30%" r="70%">
            <stop offset="0%"   stopColor="#ffffff"   stopOpacity="0.85" />
            <stop offset="45%"  stopColor={dotColor}  stopOpacity="1" />
            <stop offset="100%" stopColor={dotColor}  stopOpacity="1" />
          </radialGradient>
        </defs>

        {/* Plot background */}
        <rect
          x={PAD} y={PAD}
          width={plot} height={plot}
          rx={12}
          fill="url(#bcBg)"
          stroke="var(--border, #dde2ec)"
          strokeWidth={1}
        />

        {/* Concentric grid rings */}
        {ringFractions.map((f) => (
          <circle
            key={`ring-${f}`}
            cx={cx} cy={cy}
            r={(plot / 2) * f}
            stroke="var(--border, #dde2ec)"
            strokeWidth={0.8}
            strokeDasharray="3 4"
            fill="none"
            opacity={0.75}
          />
        ))}

        {/* Zero crosshair */}
        <line
          x1={PAD} y1={cy}
          x2={PAD + plot} y2={cy}
          stroke="var(--text-muted, #6b7280)"
          strokeWidth={1}
          opacity={0.55}
        />
        <line
          x1={cx} y1={PAD}
          x2={cx} y2={PAD + plot}
          stroke="var(--text-muted, #6b7280)"
          strokeWidth={1}
          opacity={0.55}
        />

        {/* Axis tick labels (at ½ and full range) */}
        {tickFractions.map((f) => {
          const v  = Math.round(axisHalf * f);
          const rX = cx + (plot / 2) * f;
          const lX = cx - (plot / 2) * f;
          const uY = cy - (plot / 2) * f;
          const dY = cy + (plot / 2) * f;
          return (
            <g key={`tick-${f}`}>
              <text x={rX} y={cy + 12} fill="var(--text-muted)" fontSize={9} textAnchor="middle">
                {`+${v}`}
              </text>
              <text x={lX} y={cy + 12} fill="var(--text-muted)" fontSize={9} textAnchor="middle">
                {`-${v}`}
              </text>
              <text x={cx + 4} y={uY + 3} fill="var(--text-muted)" fontSize={9} textAnchor="start">
                {`+${v}`}
              </text>
              <text x={cx + 4} y={dY + 3} fill="var(--text-muted)" fontSize={9} textAnchor="start">
                {`-${v}`}
              </text>
            </g>
          );
        })}

        {/* Axis labels */}
        <text
          x={PAD + plot - 2}
          y={PAD + plot + 18}
          fill="var(--text-muted)"
          fontSize={10}
          fontWeight={700}
          textAnchor="end"
        >
          水平位移 →
        </text>
        <text
          x={PAD - 4}
          y={PAD - 8}
          fill="var(--text-muted)"
          fontSize={10}
          fontWeight={700}
          textAnchor="start"
        >
          ↑ 垂直位移 (扣除重力)
        </text>

        {/* Trail line from origin to the dot */}
        <line
          x1={cx} y1={cy}
          x2={dotX} y2={dotY}
          stroke={dotColor}
          strokeWidth={1.25}
          strokeDasharray="2 3"
          opacity={0.55}
        />
        <circle cx={dotX} cy={dotY} r={haloR} fill={dotColor} opacity={0.18} />
        <circle
          cx={dotX} cy={dotY}
          r={7.5}
          fill="url(#bcDot)"
          stroke={dotColor}
          strokeWidth={1.5}
        />

        {/* Origin marker */}
        <circle cx={cx} cy={cy} r={2.5} fill="var(--text-muted)" opacity={0.8} />
      </svg>

      {/* Value read-out */}
      <div style={{
        display: "flex",
        alignItems: "center",
        marginTop: 10,
        padding: "0 20px",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 96 }}>
          <span style={{
            fontSize: 18,
            fontWeight: 800,
            color: "var(--text)",
            fontVariantNumeric: "tabular-nums",
          }}>
            {horizontalCm >= 0 ? "+" : ""}{horizontalCm.toFixed(1)}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>cm</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 6 }}>水平 H</span>
        </div>
        <div style={{
          width: 1,
          alignSelf: "stretch",
          background: "var(--border)",
          margin: "0 14px",
        }} />
        <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 96 }}>
          <span style={{
            fontSize: 18,
            fontWeight: 800,
            color: inducedVerticalCm >= 0 ? "#059669" : "#dc2626",
            fontVariantNumeric: "tabular-nums",
          }}>
            {inducedVerticalCm >= 0 ? "+" : ""}{inducedVerticalCm.toFixed(1)}
          </span>
          <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 700 }}>cm</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)", marginLeft: 6 }}>垂直 V</span>
        </div>
      </div>
    </div>
  );
}
