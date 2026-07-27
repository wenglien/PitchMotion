import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableWithoutFeedback } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import Svg, {
  Rect,
  Circle,
  Line,
  Text as SvgText,
  Polygon,
  G,
  Defs,
  ClipPath,
  LinearGradient,
  Stop,
  Path,
} from 'react-native-svg';
import { Colors } from '../theme';
import { formatSpeed, pitchDotColor, pitchTypeLabel, speedUnitLabel } from '../utils/conversions';
import { SessionPitch } from '../types';
import { useSettings } from '../context/SettingsContext';

// ── Strike-zone bounds in raw frame-normalised coords ────────────────────
// Must match STRIKE_ZONE_* in Swift/Python and OverlayGenerator.
const DEFAULT_ZONE = { xMin: 0.33, xMax: 0.67, yMin: 0.59, yMax: 0.83 };

// ── Canvas geometry ──────────────────────────────────────────────────────
const W = 270;
const H = 310;
// The landing plane sits at the back of the volume. The larger foreground
// frame creates a quiet, room-like perspective without adding visual clutter.
const PAD_L = 68;
const PAD_T = 62;
const ZW = 134;
const ZH = 168;
const FRONT_X = 24;
const FRONT_Y = 28;
const FRONT_W = 222;
const FRONT_H = 238;

const SAFE_U = 0.055;
const SAFE_V = 0.055;

// Pitcher release starts at the foreground opening and travels toward the
// smaller landing plane at the back of the volume.
const RELEASE_3D = { u: 0.5, v: SAFE_V, z: 0.92 } as const;

// Animation timing
const ANIM_DURATION_MS = 1400;  // flight
const HOLD_AFTER_MS = 750;      // hold after landing (for impact animation)
const INTER_PITCH_MS = 250;     // gap before next pitch
const IMPACT_RING_MS = 650;     // impact ring lifetime

const TRAJ_SAMPLES = 72;

interface Props {
  pitches?: SessionPitch[];
  zoneOverride?: { xMin: number; xMax: number; yMin: number; yMax: number } | null;
  animate?: boolean;
}

interface Pt2 { x: number; y: number }
interface Pt3 { u: number; v: number; z: number }
interface PitchShapeProfile {
  family: string;
  hBreakUV: number;
  rideUV: number;
  dropUV: number;
  lateBreak: number;
  tunnel: number;
  depthPow: number;
  ballScale: number;
}

export default function StrikeZone({ pitches = [], zoneOverride = null, animate = true }: Props) {
  const { settings } = useSettings();
  const unitLabel = speedUnitLabel(settings.speedUnit);
  const zone = zoneOverride ?? DEFAULT_ZONE;
  const clipIdRef = useRef(`strikeZoneClip${Math.random().toString(36).slice(2)}`);
  const clipId = clipIdRef.current;

  // Linear perspective: z=1 is the large foreground opening, z=0 is the
  // compact landing plane. This keeps the actual landing coordinates exact.
  const project = (u: number, v: number, z: number): Pt2 => {
    const backX = PAD_L + u * ZW;
    const backY = PAD_T + v * ZH;
    const frontX = FRONT_X + u * FRONT_W;
    const frontY = FRONT_Y + v * FRONT_H;
    return {
      x: backX + (frontX - backX) * z,
      y: backY + (frontY - backY) * z,
    };
  };

  const plateToUV = (xNorm: number, yNorm: number) => ({
    u: (xNorm - zone.xMin) / (zone.xMax - zone.xMin),
    v: (yNorm - zone.yMin) / (zone.yMax - zone.yMin),
  });

  // Build a pitch-family-specific flight shape on a flat strike-zone plane.
  //
  // Measured break still wins when present, but pitch_type now provides a
  // sensible movement profile when break is weak/missing:
  //   • Fastball: straighter tunnel with ride.
  //   • Slider/Cutter: late horizontal sweep/cut.
  //   • Curveball: early tunnel, then a pronounced late dive.
  //   • Change/Sinker/Splitter: muted speed look with heavier late drop.
  //
  // The curve is sampled from a no-break release→plate line plus beta-shaped
  // movement pulses. That keeps the endpoints correct while letting the middle
  // of the pitch reveal each ball type instead of every pitch sharing the same
  // generic parabola. z only controls the 3D styling of the rendered line.
  const pitchData = useMemo(() => {
    const valid = pitches.filter(
      (p) => p.plate_x_norm != null && p.plate_y_norm != null,
    );
    return valid.map((p, i) => {
      const rawUV = plateToUV(p.plate_x_norm!, p.plate_y_norm!);
      const u = clampNum(rawUV.u, SAFE_U, 1 - SAFE_U);
      const v = clampNum(rawUV.v, SAFE_V, 1 - SAFE_V);
      const profile = pitchProfile(p.pitch_type, p.speed_kmh);

      // Normalize break (cm) to UV-space displacement.
      // Strike-zone width ≈ 43cm (17"); a 30cm horizontal break ≈ 0.7 zone widths.
      // Scale to UV (where 1.0 = full zone width/height).
      const HBREAK_CM_PER_UV = 60;   // 60cm horizontal break → 1.0 UV (full zone width)
      const VBREAK_CM_PER_UV = 60;   // 60cm vertical break  → 1.0 UV (full zone height)
      const hBreakCm = p.horizontal_break_cm ?? null;
      const vBreakCm = p.induced_vertical_break_cm ?? null;
      const hBreakUV = hBreakCm != null ? clampNum(hBreakCm / HBREAK_CM_PER_UV, -1.2, 1.2) : null;
      const vBreakUV = vBreakCm != null ? clampNum(vBreakCm / VBREAK_CM_PER_UV, -1.2, 1.2) : null;
      const measuredH = hBreakUV != null ? clampNum(hBreakUV * 0.26, -0.24, 0.24) : null;
      const measuredV = vBreakUV != null ? clampNum(-vBreakUV * 0.24, -0.22, 0.22) : null;
      const hMovement = measuredH ?? profile.hBreakUV;
      const rideMovement = measuredV != null && measuredV < 0 ? measuredV : profile.rideUV;
      const dropMovement = measuredV != null && measuredV > 0 ? measuredV : profile.dropUV;

      const samples2D: Pt2[] = [];
      const sampleZ: number[] = [];
      for (let k = 0; k < TRAJ_SAMPLES; k++) {
        const t = k / (TRAJ_SAMPLES - 1);
        const p3 = pitchShapePoint(
          RELEASE_3D,
          { u, v, z: 0 },
          t,
          profile,
          hMovement,
          rideMovement,
          dropMovement,
        );
        samples2D.push(project(p3.u, p3.v, p3.z));
        sampleZ.push(p3.z);
      }

      return {
        i,
        pitch: p,
        rawUV,
        endProj: project(u, v, 0),
        samples: samples2D,
        sampleZ,
        profile,
      };
    });
  }, [pitches, zone]);

  const clampDot = (pt: Pt2): Pt2 => ({
    x: Math.max(PAD_L + 6, Math.min(PAD_L + ZW - 6, pt.x)),
    y: Math.max(PAD_T + 6, Math.min(PAD_T + ZH - 6, pt.y)),
  });

  const [idx, setIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startTsRef = useRef<number>(Date.now());
  const lastSetMsRef = useRef<number>(0);

  // Pause animation when this screen isn't on top — drawing 60fps SVG behind a
  // navigated-away screen wastes CPU/battery for nothing the user can see.
  const isFocused = useIsFocused();

  useEffect(() => {
    setIdx(0);
    setElapsed(0);
  }, [pitchData.length]);

  useEffect(() => {
    if (!animate || pitchData.length === 0 || !isFocused) return;
    let cancelled = false;
    startTsRef.current = Date.now();
    lastSetMsRef.current = 0;
    const cycleMs = ANIM_DURATION_MS + HOLD_AFTER_MS + INTER_PITCH_MS;
    // Cap re-renders at ~30fps. We still rAF every frame for smooth time
    // reads, but only setState when enough progress has elapsed to be visible.
    // For a 1.4s flight, 33ms ≈ 2.4% progress per tick — visually identical to
    // 16ms, but halves SVG re-renders / GC pressure on weaker devices.
    const MIN_FRAME_MS = 33;

    const tick = () => {
      if (cancelled) return;
      const e = Date.now() - startTsRef.current;
      if (e - lastSetMsRef.current >= MIN_FRAME_MS) {
        lastSetMsRef.current = e;
        setElapsed(e);
      }
      if (pitchData.length > 1 && e >= cycleMs) {
        setIdx((i) => (i + 1) % pitchData.length);
        startTsRef.current = Date.now();
        lastSetMsRef.current = 0;
        setElapsed(0);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [animate, pitchData.length, idx, isFocused]);

  // Derived animation values
  const flightRaw = Math.min(1, elapsed / ANIM_DURATION_MS);
  const progress = easeOutCubic(flightRaw);
  const impactMs = Math.max(0, elapsed - ANIM_DURATION_MS);
  const impactT = Math.min(1, impactMs / IMPACT_RING_MS);
  const impactT2 = Math.min(1, Math.max(0, impactMs - 160) / IMPACT_RING_MS);

  const current = pitchData[idx];
  const currentColor = current ? pitchDotColor(current.i) : '#4f8ef7';

  const tube = useMemo(() => {
    if (!current) return null;
    return buildTube(current.samples, current.sampleZ, progress);
  }, [current, progress]);

  // Projected release point (for the "pitcher release" marker)
  const releaseProj = project(RELEASE_3D.u, RELEASE_3D.v, RELEASE_3D.z);

  const thirds = [1 / 3, 2 / 3];

  const backTL = project(0, 0, 0);
  const backTR = project(1, 0, 0);
  const backBR = project(1, 1, 0);
  const backBL = project(0, 1, 0);
  const frontTL = project(0, 0, 1);
  const frontTR = project(1, 0, 1);
  const frontBR = project(1, 1, 1);
  const frontBL = project(0, 1, 1);

  const bx = PAD_L;
  const by = PAD_T + ZH + 8;
  const bw = ZW;
  const bh = 14;
  const tip = 7;

  const ballIsNearPlate = progress > 0.7;

  const restart = () => {
    startTsRef.current = Date.now();
    setElapsed(0);
  };

  const cycleNext = () => {
    if (pitchData.length <= 1) {
      restart();
      return;
    }
    setIdx((i) => (i + 1) % pitchData.length);
    startTsRef.current = Date.now();
    setElapsed(0);
  };

  return (
    <View style={styles.container}>
      <TouchableWithoutFeedback onPress={cycleNext}>
      <Svg width={W} height={H} style={{ overflow: 'hidden' }}>
        <Defs>
          <LinearGradient id={`${clipId}-bg`} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#f8fbff" />
            <Stop offset="0.58" stopColor="#eff7fc" />
            <Stop offset="1" stopColor="#e5f0f8" />
          </LinearGradient>
          <LinearGradient id={`${clipId}-left-wall`} x1="0" y1="0" x2="1" y2="0">
            <Stop offset="0" stopColor="#dbeafe" stopOpacity={0.05} />
            <Stop offset="1" stopColor="#38bdf8" stopOpacity={0.2} />
          </LinearGradient>
          <LinearGradient id={`${clipId}-right-wall`} x1="1" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#0284c7" stopOpacity={0.2} />
            <Stop offset="1" stopColor="#e0f2fe" stopOpacity={0.04} />
          </LinearGradient>
          <LinearGradient id={`${clipId}-landing`} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#e0f2fe" stopOpacity={0.7} />
            <Stop offset="1" stopColor="#bae6fd" stopOpacity={0.35} />
          </LinearGradient>
          <ClipPath id={clipId}>
            <Rect x={10} y={16} width={W - 20} height={H - 46} rx={16} />
          </ClipPath>
        </Defs>

        {/* Background */}
        <Rect x={0} y={0} width={W} height={H} fill={`url(#${clipId}-bg)`} rx={16} />
        <Circle cx={W / 2} cy={H * 0.42} r={118} fill="rgba(255,255,255,0.44)" />

        {/* 3D volume: restrained glass walls, so the ball flight stays primary. */}
        <Polygon
          points={`${frontTL.x},${frontTL.y} ${frontBL.x},${frontBL.y} ${backBL.x},${backBL.y} ${backTL.x},${backTL.y}`}
          fill={`url(#${clipId}-left-wall)`}
        />
        <Polygon
          points={`${frontTR.x},${frontTR.y} ${frontBR.x},${frontBR.y} ${backBR.x},${backBR.y} ${backTR.x},${backTR.y}`}
          fill={`url(#${clipId}-right-wall)`}
        />
        <Polygon
          points={`${frontTL.x},${frontTL.y} ${frontTR.x},${frontTR.y} ${backTR.x},${backTR.y} ${backTL.x},${backTL.y}`}
          fill="rgba(125,211,252,0.08)"
        />
        {[ [frontTL, backTL], [frontTR, backTR], [frontBR, backBR], [frontBL, backBL] ].map(([front, back], i) => (
          <Line
            key={`depth-edge-${i}`}
            x1={front.x}
            y1={front.y}
            x2={back.x}
            y2={back.y}
            stroke="rgba(14,165,233,0.15)"
            strokeWidth={1}
          />
        ))}

        {/* Corner brackets imply the foreground opening without a heavy box. */}
        <Path d={`M ${frontTL.x + 20} ${frontTL.y} H ${frontTL.x} V ${frontTL.y + 20}`} fill="none" stroke="rgba(15,23,42,0.42)" strokeWidth={1.6} strokeLinecap="round" />
        <Path d={`M ${frontTR.x - 20} ${frontTR.y} H ${frontTR.x} V ${frontTR.y + 20}`} fill="none" stroke="rgba(15,23,42,0.42)" strokeWidth={1.6} strokeLinecap="round" />
        <Path d={`M ${frontBR.x - 20} ${frontBR.y} H ${frontBR.x} V ${frontBR.y - 20}`} fill="none" stroke="rgba(15,23,42,0.34)" strokeWidth={1.6} strokeLinecap="round" />
        <Path d={`M ${frontBL.x + 20} ${frontBL.y} H ${frontBL.x} V ${frontBL.y - 20}`} fill="none" stroke="rgba(15,23,42,0.34)" strokeWidth={1.6} strokeLinecap="round" />

        {/* The only grid: the far landing plane, where pitches are recorded. */}
        <Rect
          x={PAD_L - 5}
          y={PAD_T - 5}
          width={ZW + 10}
          height={ZH + 10}
          fill="none"
          stroke="rgba(14,165,233,0.12)"
          strokeWidth={7}
          rx={6}
        />
        <Rect
          x={PAD_L}
          y={PAD_T}
          width={ZW}
          height={ZH}
          fill={`url(#${clipId}-landing)`}
          stroke="rgba(2,132,199,0.76)"
          strokeWidth={1.5}
          rx={4}
        />
        {thirds.map((t, i) => (
          <G key={`landing-grid-${i}`}>
            <Line
              x1={PAD_L + ZW * t}
              y1={PAD_T}
              x2={PAD_L + ZW * t}
              y2={PAD_T + ZH}
              stroke="rgba(14,165,233,0.13)"
              strokeWidth={0.8}
            />
            <Line
              x1={PAD_L}
              y1={PAD_T + ZH * t}
              x2={PAD_L + ZW}
              y2={PAD_T + ZH * t}
              stroke="rgba(14,165,233,0.13)"
              strokeWidth={0.8}
            />
          </G>
        ))}

        {/* Title */}
        <SvgText
          x={W / 2}
          y={15}
          textAnchor="middle"
          fontSize={8}
          fill="rgba(71,85,105,0.74)"
          fontFamily="System"
          letterSpacing={1}
        >
          PITCH SPACE
        </SvgText>
        <SvgText
          x={W / 2}
          y={PAD_T - 9}
          textAnchor="middle"
          fontSize={7.5}
          fill="rgba(2,132,199,0.72)"
          fontFamily="System"
          letterSpacing={0.6}
        >
          IMPACT PLANE
        </SvgText>

        {/* Home plate */}
        <Polygon
          points={`${bx},${by} ${bx + bw},${by} ${bx + bw},${by + bh - tip} ${bx + bw / 2},${by + bh} ${bx},${by + bh - tip}`}
          fill="rgba(255,255,255,0.72)"
          stroke="rgba(2,132,199,0.30)"
          strokeWidth={1.2}
        />

        {/* ── Release-point marker ── */}
        {pitchData.length > 0 && (
          <G opacity={0.8}>
            <Circle cx={releaseProj.x} cy={releaseProj.y} r={9} fill="rgba(14,165,233,0.12)" />
            <Circle
              cx={releaseProj.x}
              cy={releaseProj.y}
              r={3.5}
              fill="rgba(255,255,255,0.9)"
              stroke="rgba(2,132,199,0.85)"
              strokeWidth={1.2}
            />
            <Circle cx={releaseProj.x - 0.9} cy={releaseProj.y - 0.9} r={1} fill="#ffffff" />
          </G>
        )}

        <G clipPath={`url(#${clipId})`}>
          {/* ── Ghost trails of all OTHER pitches ── */}
          {pitchData.length > 1 && pitchData.map((pd) => {
            if (current?.i === pd.i) return null;
            const pts = pd.samples;
            const segs: { x1: number; y1: number; x2: number; y2: number; alpha: number }[] = [];
            for (let k = 0; k < pts.length - 1; k++) {
              const z = pd.sampleZ[k];
              segs.push({
                x1: pts[k].x,
                y1: pts[k].y,
                x2: pts[k + 1].x,
                y2: pts[k + 1].y,
                alpha: 0.08 + 0.22 * (1 - z),
              });
            }
            const ghostColor = pitchDotColor(pd.i);
            return (
              <G key={`ghost-${pd.i}`} opacity={0.5}>
                {segs.map((s, k) => (
                  <Line
                    key={`g${pd.i}-${k}`}
                    x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2}
                    stroke={ghostColor}
                    strokeOpacity={s.alpha}
                    strokeWidth={1.35}
                    strokeLinecap="round"
                  />
                ))}
              </G>
            );
          })}

          {/* ── 3D-styled trajectory (tapered tube + shadow + highlight) ── */}
          {current && animate && tube && tube.segments.length > 0 && (
            <G>
              {tube.segments.map((seg, i) => (
                <Line
                  key={`sh-${i}`}
                  x1={seg.x1}
                  y1={seg.y1 + seg.shadowOffset}
                  x2={seg.x2}
                  y2={seg.y2 + seg.shadowOffset}
                  stroke="rgba(0,0,0,0.24)"
                  strokeWidth={seg.width * 0.8}
                  strokeOpacity={seg.shadowAlpha}
                  strokeLinecap="round"
                />
              ))}

              {tube.segments.map((seg, i) => (
                <Line
                  key={`gl-${i}`}
                  x1={seg.x1}
                  y1={seg.y1}
                  x2={seg.x2}
                  y2={seg.y2}
                  stroke={currentColor}
                  strokeOpacity={0.14}
                  strokeWidth={seg.width * 2.2}
                  strokeLinecap="round"
                />
              ))}

              {tube.segments.map((seg, i) => (
                <Line
                  key={`core-${i}`}
                  x1={seg.x1}
                  y1={seg.y1}
                  x2={seg.x2}
                  y2={seg.y2}
                  stroke={currentColor}
                  strokeOpacity={seg.coreAlpha}
                  strokeWidth={seg.width}
                  strokeLinecap="round"
                />
              ))}

              {tube.segments.map((seg, i) => (
                <Line
                  key={`hi-${i}`}
                  x1={seg.x1 - seg.nx}
                  y1={seg.y1 - seg.ny}
                  x2={seg.x2 - seg.nx}
                  y2={seg.y2 - seg.ny}
                  stroke="rgba(255,255,255,0.62)"
                  strokeOpacity={seg.highlightAlpha}
                  strokeWidth={seg.width * 0.32}
                  strokeLinecap="round"
                />
              ))}
            </G>
          )}

          {/* Moving ball head (only during flight) */}
          {tube?.ball && progress > 0 && progress < 1 && (
            <G>
              <Circle cx={tube.ball.x} cy={tube.ball.y} r={13 * current.profile.ballScale} fill={currentColor} opacity={0.18} />
              <Circle cx={tube.ball.x} cy={tube.ball.y} r={6.6 * current.profile.ballScale} fill="#ffffff" stroke={currentColor} strokeWidth={2.1} />
              <Circle cx={tube.ball.x - 1.4} cy={tube.ball.y - 1.4} r={1.8} fill="rgba(255,255,255,0.95)" />
            </G>
          )}

          {/* ── Secondary ball "splash" when near plate ── */}
          {current && ballIsNearPlate && progress < 1 && tube?.ball && (
            <G opacity={(progress - 0.7) / 0.3}>
              {[-1, 1].map((dir) => {
                const len = 8 + 5 * ((progress - 0.7) / 0.3);
                return (
                  <Line
                    key={`sp-${dir}`}
                    x1={tube.ball!.x - dir * 3}
                    y1={tube.ball!.y - dir * 2}
                    x2={tube.ball!.x - dir * (3 + len)}
                    y2={tube.ball!.y - dir * (2 + len * 0.36)}
                    stroke={currentColor}
                    strokeOpacity={0.28}
                    strokeWidth={1.8}
                    strokeLinecap="round"
                  />
                );
              })}
            </G>
          )}
        </G>

        {/* ── Impact rings at landing (after flight ends) ── */}
        {current && progress >= 1 && impactMs >= 0 && impactMs < IMPACT_RING_MS + 200 && (
          <G>
            <Circle
              cx={current.endProj.x}
              cy={current.endProj.y}
              r={6 + impactT * 24}
              fill="none"
              stroke={currentColor}
              strokeWidth={2.2 * (1 - impactT)}
              opacity={1 - impactT}
            />
            {impactT2 > 0 && (
              <Circle
                cx={current.endProj.x}
                cy={current.endProj.y}
                r={6 + impactT2 * 18}
                fill="none"
                stroke={currentColor}
                strokeWidth={1.6 * (1 - impactT2)}
                opacity={0.75 * (1 - impactT2)}
              />
            )}
          </G>
        )}

        {/* ── Pitch landing markers ──────────────────────── */}
        {pitchData.map(({ endProj, i, rawUV }) => {
          const { x, y } = clampDot(endProj);
          const color = pitchDotColor(i);
          const inZone =
            rawUV.u >= 0 && rawUV.u <= 1 &&
            rawUV.v >= 0 && rawUV.v <= 1;
          const isCurrent = current?.i === i;
          const active = isCurrent && progress >= 1;

          // Pulse scale when active
          const pulse = active ? 1 + 0.15 * Math.max(0, 1 - impactT * 1.4) : 1;
          const dotR = 7 * pulse;
          const haloR = active ? 14 : 10;
          const haloOp = active ? 0.28 : isCurrent ? 0.22 : 0.14;

          return (
            <G key={i} opacity={isCurrent || !current ? 1 : 0.55}>
              {/* Halo */}
              <Circle cx={x} cy={y} r={haloR} fill={color} opacity={haloOp} />
              {/* Outer ring */}
              <Circle
                cx={x}
                cy={y}
                r={dotR + 2}
                fill="none"
                stroke={inZone ? 'rgba(255,255,255,0.95)' : 'rgba(240,90,90,0.95)'}
                strokeWidth={1.2}
              />
              {/* Core dot */}
              <Circle
                cx={x}
                cy={y}
                r={dotR}
                fill={color}
                stroke="#ffffff"
                strokeWidth={0.8}
                opacity={0.98}
              />
              {/* Inner sheen */}
              <Circle cx={x - 1.6} cy={y - 1.8} r={1.8} fill="rgba(255,255,255,0.55)" />
              {/* Number */}
              <SvgText
                x={x}
                y={y + 3.2}
                textAnchor="middle"
                fontSize={8}
                fill="#ffffff"
                fontWeight="bold"
                fontFamily="System"
              >
                {i + 1}
              </SvgText>
            </G>
          );
        })}

        {/* Empty state */}
        {pitchData.length === 0 && (
          <SvgText
            x={W / 2}
            y={PAD_T + ZH / 2 + 4}
            textAnchor="middle"
            fontSize={12}
            fill="rgba(150,150,150,0.4)"
            fontFamily="System"
          >
            尚無投球落點
          </SvgText>
        )}

      </Svg>
      </TouchableWithoutFeedback>

      {/* ── Now-playing info ticker (Statcast-style HUD) ── */}
      {current && (
        <View style={styles.ticker}>
          <View style={[styles.tickerSwatch, { backgroundColor: currentColor }]} />
          <Text style={styles.tickerNum}>#{current.i + 1}</Text>
          {current.pitch.pitch_type ? (
            <Text style={styles.tickerType}>{pitchTypeLabel(current.pitch.pitch_type)}</Text>
          ) : null}
          {current.pitch.speed_kmh != null && (
            <Text style={styles.tickerSpeed}>
              {formatSpeed(current.pitch.speed_kmh, settings.speedUnit)}
              <Text style={styles.tickerUnit}> {unitLabel}</Text>
            </Text>
          )}
          {current.pitch.horizontal_break_cm != null && (
            <Text style={styles.tickerBreak}>
              H {current.pitch.horizontal_break_cm >= 0 ? '+' : ''}
              {current.pitch.horizontal_break_cm.toFixed(0)}
            </Text>
          )}
          {current.pitch.induced_vertical_break_cm != null && (
            <Text style={styles.tickerBreak}>
              V {current.pitch.induced_vertical_break_cm >= 0 ? '+' : ''}
              {current.pitch.induced_vertical_break_cm.toFixed(0)}
            </Text>
          )}
        </View>
      )}

      {/* Legend */}
      {pitchData.length > 0 && (
        <View style={styles.legend}>
          {pitchData.map(({ pitch, i }) => {
            const isCurrent = current?.i === i;
            return (
              <View key={i} style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: pitchDotColor(i) }]} />
                <Text style={[styles.legendText, isCurrent && styles.legendTextActive]}>
                  #{i + 1}
                  {pitch.pitch_type ? ` ${pitchTypeLabel(pitch.pitch_type)}` : ''}
                  {pitch.speed_kmh ? ` · ${formatSpeed(pitch.speed_kmh, settings.speedUnit, 0)}${unitLabel}` : ''}
                </Text>
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function smoothStep(edge0: number, edge1: number, x: number): number {
  const t = clampNum((x - edge0) / Math.max(1e-6, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function pitchProfile(type?: string | null, speedKmh?: number | null): PitchShapeProfile {
  const t = (type || '').toLowerCase();
  const speed = speedKmh ?? 0;
  const isPower = speed >= 145;

  if (t.includes('curve')) {
    return {
      family: 'curve',
      hBreakUV: -0.06,
      rideUV: -0.08,
      dropUV: 0.2,
      lateBreak: 0.88,
      tunnel: 0.48,
      depthPow: 1.24,
      ballScale: 0.95,
    };
  }
  if (t.includes('slider') || t.includes('sweeper')) {
    return {
      family: 'slider',
      hBreakUV: -0.16,
      rideUV: -0.02,
      dropUV: 0.08,
      lateBreak: 0.78,
      tunnel: 0.58,
      depthPow: 1.14,
      ballScale: 0.98,
    };
  }
  if (t.includes('cutter') || t.includes('cut')) {
    return {
      family: 'cutter',
      hBreakUV: -0.1,
      rideUV: -0.04,
      dropUV: 0.05,
      lateBreak: 0.68,
      tunnel: 0.68,
      depthPow: 1.08,
      ballScale: 1.02,
    };
  }
  if (t.includes('sinker') || t.includes('two-seam') || t.includes('2-seam')) {
    return {
      family: 'sinker',
      hBreakUV: 0.12,
      rideUV: 0.00,
      dropUV: 0.15,
      lateBreak: 0.72,
      tunnel: 0.62,
      depthPow: 1.12,
      ballScale: 1.0,
    };
  }
  if (t.includes('split')) {
    return {
      family: 'splitter',
      hBreakUV: 0.05,
      rideUV: 0.02,
      dropUV: 0.19,
      lateBreak: 0.82,
      tunnel: 0.66,
      depthPow: 1.18,
      ballScale: 0.96,
    };
  }
  if (t.includes('change')) {
    return {
      family: 'changeup',
      hBreakUV: 0.09,
      rideUV: 0.01,
      dropUV: 0.13,
      lateBreak: 0.70,
      tunnel: 0.66,
      depthPow: 1.20,
      ballScale: 0.96,
    };
  }
  if (t.includes('fast') || t.includes('four') || t.includes('4-seam')) {
    return {
      family: 'fastball',
      hBreakUV: isPower ? 0.025 : 0.04,
      rideUV: isPower ? -0.09 : -0.07,
      dropUV: 0.025,
      lateBreak: 0.45,
      tunnel: 0.78,
      depthPow: 1.00,
      ballScale: 1.06,
    };
  }

  return {
    family: 'unknown',
    hBreakUV: 0.045,
    rideUV: -0.035,
    dropUV: 0.09,
    lateBreak: 0.60,
    tunnel: 0.64,
    depthPow: 1.12,
    ballScale: 1.0,
  };
}

function pitchShapePoint(
  start: Pt3,
  end: Pt3,
  t: number,
  profile: PitchShapeProfile,
  hMovement: number,
  rideMovement: number,
  dropMovement: number,
): Pt3 {
  const sideBias = end.u >= start.u ? 1 : -1;
  const arcLift = profile.family === 'curve'
    ? 0.18
    : profile.family === 'fastball'
      ? 0.1
      : 0.135;
  const lateWeight = 0.34 + profile.lateBreak * 0.2;
  const rideLift = clampNum(-rideMovement, -0.04, 0.16);
  const dropSag = clampNum(dropMovement, 0, 0.2);
  const horizontalBend = clampNum(hMovement, -0.22, 0.22);

  const c1: Pt3 = {
    u: clampNum(start.u * 0.72 + end.u * 0.28 - horizontalBend * 0.16, SAFE_U, 1 - SAFE_U),
    v: clampNum(start.v + 0.015 - rideLift * 0.18, SAFE_V, 1 - SAFE_V),
    z: 0.78,
  };
  const c2: Pt3 = {
    u: clampNum(end.u - horizontalBend * lateWeight - sideBias * 0.025, SAFE_U, 1 - SAFE_U),
    v: clampNum(end.v - arcLift - rideLift * 0.22 + dropSag * 0.12, SAFE_V, 1 - SAFE_V),
    z: 0.26,
  };

  const p = cubicBezier3(start, c1, c2, end, t);
  const settle = smoothStep(0.72, 1, t);
  const lateDrop = Math.sin(Math.PI * t) * dropSag * 0.12 * settle;

  return {
    u: clampNum(p.u, SAFE_U, 1 - SAFE_U),
    v: clampNum(p.v + lateDrop, SAFE_V, 1 - SAFE_V),
    z: Math.pow(1 - t, profile.depthPow),
  };
}

function cubicBezier3(p0: Pt3, p1: Pt3, p2: Pt3, p3: Pt3, t: number): Pt3 {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    u: a * p0.u + b * p1.u + c * p2.u + d * p3.u,
    v: a * p0.v + b * p1.v + c * p2.v + d * p3.v,
    z: a * p0.z + b * p1.z + c * p2.z + d * p3.z,
  };
}

interface TubeSegment {
  x1: number; y1: number;
  x2: number; y2: number;
  width: number;
  coreAlpha: number;
  highlightAlpha: number;
  shadowAlpha: number;
  shadowOffset: number;
  nx: number; ny: number;
}

function buildTube(
  pts2D: Pt2[],
  zs: number[],
  progress: number,
): { segments: TubeSegment[]; ball: Pt2 | null } {
  if (pts2D.length < 2) return { segments: [], ball: null };
  if (progress <= 0) return { segments: [], ball: pts2D[0] };

  const dists: number[] = [0];
  let total = 0;
  for (let i = 1; i < pts2D.length; i++) {
    total += Math.hypot(pts2D[i].x - pts2D[i - 1].x, pts2D[i].y - pts2D[i - 1].y);
    dists.push(total);
  }
  const target = total * progress;

  const segments: TubeSegment[] = [];
  let ball: Pt2 = pts2D[0];

  for (let i = 0; i < pts2D.length - 1; i++) {
    const d1 = dists[i];
    const d2 = dists[i + 1];
    if (d1 >= target) break;

    const p1 = pts2D[i];
    let p2 = pts2D[i + 1];
    let z2 = zs[i + 1];
    if (d2 > target) {
      const t = d2 === d1 ? 0 : (target - d1) / (d2 - d1);
      p2 = { x: p1.x + (pts2D[i + 1].x - p1.x) * t, y: p1.y + (pts2D[i + 1].y - p1.y) * t };
      z2 = zs[i] + (zs[i + 1] - zs[i]) * t;
    }
    const z1 = zs[i];
    const zAvg = (z1 + z2) / 2;

    const widthNear = 6.5;
    const widthFar = 1.4;
    const width = widthFar + (widthNear - widthFar) * (1 - zAvg);
    const coreAlpha = 0.55 + 0.45 * (1 - zAvg);
    const highlightAlpha = 0.15 + 0.6 * (1 - zAvg);
    const shadowAlpha = 0.05 + 0.4 * (1 - zAvg);
    const shadowOffset = 2 + 11 * (1 - zAvg);

    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;

    segments.push({
      x1: p1.x, y1: p1.y,
      x2: p2.x, y2: p2.y,
      width,
      coreAlpha,
      highlightAlpha,
      shadowAlpha,
      shadowOffset,
      nx, ny,
    });

    ball = p2;
    if (d2 > target) break;
  }

  return { segments, ball };
}

const styles = StyleSheet.create({
  container: { alignItems: 'center' },
  legend: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    marginTop: 8,
    justifyContent: 'center',
    maxWidth: 230,
    columnGap: 10,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  legendDot: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
  },
  legendText: {
    fontSize: 11,
    color: Colors.textMuted,
  },
  legendTextActive: {
    color: Colors.text ?? '#e5e7eb',
    fontWeight: '700',
  },
  ticker: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: 'rgba(15,23,42,0.06)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(15,23,42,0.1)',
    maxWidth: 230,
    flexWrap: 'wrap',
  },
  tickerSwatch: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  tickerNum: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.text,
    fontVariant: ['tabular-nums'],
  },
  tickerType: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.text,
  },
  tickerSpeed: {
    fontSize: 12,
    fontWeight: '800',
    color: Colors.text,
    fontVariant: ['tabular-nums'],
  },
  tickerUnit: {
    fontSize: 9,
    fontWeight: '600',
    color: Colors.textMuted,
  },
  tickerBreak: {
    fontSize: 10,
    fontWeight: '600',
    color: Colors.textMuted,
    fontVariant: ['tabular-nums'],
  },
});
