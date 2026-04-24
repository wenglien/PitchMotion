import React, { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, {
  Circle,
  Line,
  Rect,
  Text as SvgText,
  G,
  Defs,
  RadialGradient,
  Stop,
} from 'react-native-svg';
import { Colors, PitchColors } from '../theme';

// ── MLB-style two-axis break chart ───────────────────────────────────────
//
// Shows a single pitch as a coloured dot on a symmetric X/Y plot:
//   X axis = horizontal break (cm) — + right, − left
//   Y axis = induced vertical break (cm) — + rise, − drop (gravity removed)
// Background grid + crosshair origin matches the MLB "pitch movement"
// visualisation style used on Baseball-Savant.
//
// Props
//   horizontalCm            horizontal break in cm (signed, + = right)
//   inducedVerticalCm       induced vertical break (signed, + = rise)
//   pitchType               optional label — drives the dot colour
//   confidence              optional 0..1 — rendered as faint halo radius
//
// Behaviour
//   - Axis range auto-scales up to at least ±50cm to avoid tiny dots in
//     the corner for big-break pitches.
//   - If confidence is low or break data missing, the caller should not
//     render this component.

export interface BreakChartProps {
  horizontalCm: number;
  inducedVerticalCm: number;
  pitchType?: string | null;
  confidence?: number;
}

const SIZE = 240;                  // square canvas
const PAD = 28;                    // inner padding for labels
const AXIS_MIN = 50;               // minimum axis half-range (cm)

function roundUpNice(v: number): number {
  // Round up to 10 / 25 / 50 / 75 / 100 …
  if (v <= 25) return 25;
  if (v <= 50) return 50;
  if (v <= 75) return 75;
  if (v <= 100) return 100;
  return Math.ceil(v / 25) * 25;
}

export const BreakChart: React.FC<BreakChartProps> = ({
  horizontalCm,
  inducedVerticalCm,
  pitchType,
  confidence,
}) => {
  const dotColor = (pitchType && PitchColors[pitchType]) || '#4f8ef7';

  // Auto-scale axis half-range (cm) so the dot stays inside the plot.
  const axisHalf = useMemo(() => {
    const peak = Math.max(
      AXIS_MIN,
      Math.abs(horizontalCm) * 1.25,
      Math.abs(inducedVerticalCm) * 1.25,
    );
    return roundUpNice(peak);
  }, [horizontalCm, inducedVerticalCm]);

  // Plot area
  const plot = SIZE - PAD * 2;
  const cx = PAD + plot / 2;
  const cy = PAD + plot / 2;

  // cm → px (screen Y is inverted: up on screen = positive induced break)
  const scale = plot / 2 / axisHalf;
  const dotX = cx + horizontalCm * scale;
  const dotY = cy - inducedVerticalCm * scale;

  // Concentric grid rings (at axisHalf × {0.25, 0.5, 0.75, 1.0})
  const ringFractions = [0.25, 0.5, 0.75, 1.0];
  // Tick labels on both axes (at ½ and full)
  const tickFractions = [0.5, 1.0];

  const conf = typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : 0.6;
  const haloR = 11 + (1 - conf) * 8;

  return (
    <View style={styles.wrap}>
      <Svg width={SIZE} height={SIZE}>
        <Defs>
          <RadialGradient id="bgGrad" cx="50%" cy="50%" r="60%">
            <Stop offset="0%" stopColor="#f8fafc" stopOpacity="1" />
            <Stop offset="100%" stopColor="#eef1f6" stopOpacity="1" />
          </RadialGradient>
          <RadialGradient id="dotGrad" cx="30%" cy="30%" r="70%">
            <Stop offset="0%" stopColor="#ffffff" stopOpacity="0.85" />
            <Stop offset="45%" stopColor={dotColor} stopOpacity="1" />
            <Stop offset="100%" stopColor={dotColor} stopOpacity="1" />
          </RadialGradient>
        </Defs>

        {/* Plot background */}
        <Rect
          x={PAD}
          y={PAD}
          width={plot}
          height={plot}
          rx={12}
          fill="url(#bgGrad)"
          stroke={Colors.border}
          strokeWidth={1}
        />

        {/* Concentric grid rings */}
        {ringFractions.map((f) => (
          <Circle
            key={`ring-${f}`}
            cx={cx}
            cy={cy}
            r={(plot / 2) * f}
            stroke={Colors.border}
            strokeWidth={0.8}
            strokeDasharray="3 4"
            fill="none"
            opacity={0.75}
          />
        ))}

        {/* Zero crosshair */}
        <Line
          x1={PAD}
          y1={cy}
          x2={PAD + plot}
          y2={cy}
          stroke={Colors.textMuted}
          strokeWidth={1}
          opacity={0.55}
        />
        <Line
          x1={cx}
          y1={PAD}
          x2={cx}
          y2={PAD + plot}
          stroke={Colors.textMuted}
          strokeWidth={1}
          opacity={0.55}
        />

        {/* Axis tick labels */}
        {tickFractions.map((f) => {
          const v = Math.round(axisHalf * f);
          const rX = cx + (plot / 2) * f;
          const lX = cx - (plot / 2) * f;
          const uY = cy - (plot / 2) * f;
          const dY = cy + (plot / 2) * f;
          return (
            <G key={`tick-${f}`}>
              {/* Right */}
              <SvgText x={rX} y={cy + 12} fill={Colors.textMuted} fontSize={9} textAnchor="middle">
                {`+${v}`}
              </SvgText>
              {/* Left */}
              <SvgText x={lX} y={cy + 12} fill={Colors.textMuted} fontSize={9} textAnchor="middle">
                {`-${v}`}
              </SvgText>
              {/* Up */}
              <SvgText x={cx + 4} y={uY + 3} fill={Colors.textMuted} fontSize={9} textAnchor="start">
                {`+${v}`}
              </SvgText>
              {/* Down */}
              <SvgText x={cx + 4} y={dY + 3} fill={Colors.textMuted} fontSize={9} textAnchor="start">
                {`-${v}`}
              </SvgText>
            </G>
          );
        })}

        {/* Axis labels */}
        <SvgText
          x={PAD + plot - 2}
          y={PAD + plot + 18}
          fill={Colors.textMuted}
          fontSize={10}
          fontWeight="700"
          textAnchor="end"
        >
          水平位移 →
        </SvgText>
        <SvgText
          x={PAD - 4}
          y={PAD - 8}
          fill={Colors.textMuted}
          fontSize={10}
          fontWeight="700"
          textAnchor="start"
        >
          ↑ 垂直位移 (扣除重力)
        </SvgText>

        {/* Pitch dot — trail line from origin for nicer visualisation */}
        <Line
          x1={cx}
          y1={cy}
          x2={dotX}
          y2={dotY}
          stroke={dotColor}
          strokeWidth={1.25}
          strokeDasharray="2 3"
          opacity={0.55}
        />
        <Circle cx={dotX} cy={dotY} r={haloR} fill={dotColor} opacity={0.18} />
        <Circle cx={dotX} cy={dotY} r={7.5} fill="url(#dotGrad)" stroke={dotColor} strokeWidth={1.5} />

        {/* Origin marker */}
        <Circle cx={cx} cy={cy} r={2.5} fill={Colors.textMuted} opacity={0.8} />
      </Svg>

      {/* Value read-out under the chart */}
      <View style={styles.readRow}>
        <View style={styles.readItem}>
          <Text style={styles.readVal}>
            {horizontalCm >= 0 ? '+' : ''}
            {horizontalCm.toFixed(1)}
          </Text>
          <Text style={styles.readUnit}>cm</Text>
          <Text style={styles.readLbl}>水平 H</Text>
        </View>
        <View style={styles.readDivider} />
        <View style={styles.readItem}>
          <Text style={[styles.readVal, { color: inducedVerticalCm >= 0 ? '#059669' : '#dc2626' }]}>
            {inducedVerticalCm >= 0 ? '+' : ''}
            {inducedVerticalCm.toFixed(1)}
          </Text>
          <Text style={styles.readUnit}>cm</Text>
          <Text style={styles.readLbl}>垂直 V</Text>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  readRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
    paddingHorizontal: 20,
  },
  readItem: {
    alignItems: 'center',
    minWidth: 96,
    flexDirection: 'row',
    gap: 4,
  },
  readVal: {
    fontSize: 18,
    fontWeight: '800',
    color: Colors.text,
    fontVariant: ['tabular-nums'],
  },
  readUnit: { fontSize: 11, color: Colors.textMuted, fontWeight: '700' },
  readLbl: { fontSize: 12, color: Colors.textMuted, marginLeft: 6 },
  readDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: Colors.border,
    alignSelf: 'stretch',
    marginHorizontal: 14,
  },
});

export default BreakChart;
