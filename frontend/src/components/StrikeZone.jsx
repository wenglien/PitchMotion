import { useEffect, useMemo, useRef, useState } from "react";

// Port of mobile/src/components/StrikeZone.tsx — oblique 3D trajectory + rAF animation.

// Must mirror backend src/get_pitch_frames_yolov8.py STRIKE_ZONE_* constants
// so the dot/strike classification shown here matches the overlay drawn on
// the analysed video. Any per-job value in speed_info.plate_zone should be
// preferred via the zoneOverride prop.
const DEFAULT_ZONE = { xMin: 0.33, xMax: 0.67, yMin: 0.56, yMax: 0.86 };
const COL_LABELS = ["In", "Mid", "Out"];
const ROW_LABELS = ["High", "Mid", "Low"];

const PITCH_PALETTE = [
  "#4f8ef7", "#22d3a5", "#f5c542", "#f05a5a",
  "#7c5cfc", "#f07a5a", "#22c0d3", "#e056e0",
];

function pitchDotColor(i) {
  return PITCH_PALETTE[i % PITCH_PALETTE.length];
}

const W = 230;
const H = 278;
const PAD_L = 32;
const PAD_T = 34;
const PAD_R = 16;
const PAD_B = 36;
const ZW = W - PAD_L - PAD_R;
const ZH = H - PAD_T - PAD_B;

const DEPTH_DX = 28;
const DEPTH_DY = -28;

// Pitcher release sits at the back-top-center of the 3D strike-zone box:
// horizontally centered, aligned with the zone's top edge in normalized
// coords, and pushed to z=1 ("far"). Visually it floats just above the
// zone's front face, connected to it via the depth axis — MLB umpire POV.
const RELEASE_3D = {
  u: 0.5 - DEPTH_DX / ZW,
  v: 0,
  z: 1.0,
};

const ANIM_DURATION_MS = 1400;
const HOLD_AFTER_MS = 750;
const INTER_PITCH_MS = 250;
const IMPACT_RING_MS = 650;
const TRAJ_SAMPLES = 48;

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function cubicBezier3(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const u2 = u * u;
  const u3 = u2 * u;
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    u: u3 * p0.u + 3 * u2 * t * p1.u + 3 * u * t2 * p2.u + t3 * p3.u,
    v: u3 * p0.v + 3 * u2 * t * p1.v + 3 * u * t2 * p2.v + t3 * p3.v,
    z: u3 * p0.z + 3 * u2 * t * p1.z + 3 * u * t2 * p2.z + t3 * p3.z,
  };
}

function buildTube(pts2D, zs, progress) {
  if (pts2D.length < 2) return { segments: [], ball: null };
  if (progress <= 0) return { segments: [], ball: pts2D[0] };

  const dists = [0];
  let total = 0;
  for (let i = 1; i < pts2D.length; i++) {
    total += Math.hypot(pts2D[i].x - pts2D[i - 1].x, pts2D[i].y - pts2D[i - 1].y);
    dists.push(total);
  }
  const target = total * progress;

  const segments = [];
  let ball = pts2D[0];

  for (let i = 0; i < pts2D.length - 1; i++) {
    const d1 = dists[i];
    const d2 = dists[i + 1];
    if (d1 >= target) break;

    const p1 = pts2D[i];
    let p2 = pts2D[i + 1];
    let z2 = zs[i + 1];
    if (d2 > target) {
      const tt = d2 === d1 ? 0 : (target - d1) / (d2 - d1);
      p2 = {
        x: p1.x + (pts2D[i + 1].x - p1.x) * tt,
        y: p1.y + (pts2D[i + 1].y - p1.y) * tt,
      };
      z2 = zs[i] + (zs[i + 1] - zs[i]) * tt;
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

export default function StrikeZone({ pitches = [], zoneOverride = null, animate = true }) {
  const zone = useMemo(
    () => zoneOverride ?? DEFAULT_ZONE,
    [
      zoneOverride?.xMin,
      zoneOverride?.xMax,
      zoneOverride?.yMin,
      zoneOverride?.yMax,
    ],
  );

  const project = (u, v, z) => ({
    x: PAD_L + u * ZW + DEPTH_DX * z,
    y: PAD_T + v * ZH + DEPTH_DY * z,
  });

  const plateToUV = (xNorm, yNorm) => ({
    u: (xNorm - zone.xMin) / (zone.xMax - zone.xMin),
    v: (yNorm - zone.yMin) / (zone.yMax - zone.yMin),
  });

  const pitchData = useMemo(() => {
    const valid = pitches.filter(
      (p) => p.plate_x_norm != null && p.plate_y_norm != null,
    );
    return valid.map((p, i) => {
      const { u, v } = plateToUV(p.plate_x_norm, p.plate_y_norm);
      const sideSign = u >= 0.5 ? 1 : -1;

      // Linear-ish interp between release and target in (u, v); z carries
      // the depth change from 1 → 0, which (combined with DEPTH_DY = -28)
      // makes the projected screen-y descend naturally from release to
      // plate — no upward arch for in-zone or mildly-high pitches.
      const P0 = { ...RELEASE_3D };
      const P1 = {
        u: RELEASE_3D.u * 0.75 + u * 0.25,
        v: RELEASE_3D.v + (v - RELEASE_3D.v) * 0.3,
        z: 0.75,
      };
      const P2 = {
        u: RELEASE_3D.u * 0.25 + u * 0.75 + 0.03 * sideSign,
        v: RELEASE_3D.v + (v - RELEASE_3D.v) * 0.75,
        z: 0.3,
      };
      const P3 = { u, v, z: 0 };

      const samples2D = [];
      const sampleZ = [];
      for (let k = 0; k < TRAJ_SAMPLES; k++) {
        const t = k / (TRAJ_SAMPLES - 1);
        const p3 = cubicBezier3(P0, P1, P2, P3, t);
        samples2D.push(project(p3.u, p3.v, p3.z));
        sampleZ.push(p3.z);
      }

      return {
        i,
        pitch: p,
        endProj: project(u, v, 0),
        samples: samples2D,
        sampleZ,
      };
    });
  }, [pitches, zone]);

  const clampDot = (pt) => ({
    x: Math.max(PAD_L - 4, Math.min(PAD_L + ZW + 4, pt.x)),
    y: Math.max(PAD_T - 4, Math.min(PAD_T + ZH + 4, pt.y)),
  });

  const [idx, setIdx] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const rafRef = useRef(null);
  const startTsRef = useRef(Date.now());

  useEffect(() => {
    setIdx(0);
    setElapsed(0);
  }, [pitchData.length]);

  useEffect(() => {
    if (!animate || pitchData.length === 0) return;
    let cancelled = false;
    startTsRef.current = Date.now();
    const cycleMs = ANIM_DURATION_MS + HOLD_AFTER_MS + INTER_PITCH_MS;

    const tick = () => {
      if (cancelled) return;
      const e = Date.now() - startTsRef.current;
      setElapsed(e);
      if (pitchData.length > 1 && e >= cycleMs) {
        setIdx((j) => (j + 1) % pitchData.length);
        startTsRef.current = Date.now();
        setElapsed(0);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [animate, pitchData.length, idx]);

  const flightRaw = Math.min(1, elapsed / ANIM_DURATION_MS);
  const progress = easeOutCubic(flightRaw);
  const impactMs = Math.max(0, elapsed - ANIM_DURATION_MS);
  const impactT = Math.min(1, impactMs / IMPACT_RING_MS);
  const impactT2 = Math.min(1, Math.max(0, impactMs - 160) / IMPACT_RING_MS);

  const current = pitchData[idx];
  const currentColor = current ? pitchDotColor(current.i) : "#4f8ef7";

  const tube = useMemo(() => {
    if (!current) return null;
    return buildTube(current.samples, current.sampleZ, progress);
  }, [current, progress]);

  const releaseProj = project(RELEASE_3D.u, RELEASE_3D.v, RELEASE_3D.z);
  const thirds = [1 / 3, 2 / 3];
  const bx = PAD_L;
  const by = PAD_T + ZH + 8;
  const bw = ZW;
  const bh = 14;
  const tip = 7;
  const ballIsNearPlate = progress > 0.7;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <svg
        width={W}
        height={H}
        style={{ overflow: "visible", userSelect: "none" }}
        aria-label="Strike zone with pitch trajectory"
      >
        <rect x={0} y={0} width={W} height={H} fill="var(--surface2, #eef1f6)" rx={12} />

        <rect
          x={PAD_L} y={PAD_T}
          width={ZW} height={ZH}
          fill="rgba(79,142,247,0.06)"
          stroke="rgba(79,142,247,0.5)"
          strokeWidth={2}
          rx={3}
        />

        {thirds.map((t, i) => (
          <g key={`grid-${i}`}>
            <line
              x1={PAD_L + ZW * t} y1={PAD_T}
              x2={PAD_L + ZW * t} y2={PAD_T + ZH}
              stroke="rgba(150,150,150,0.2)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
            <line
              x1={PAD_L} y1={PAD_T + ZH * t}
              x2={PAD_L + ZW} y2={PAD_T + ZH * t}
              stroke="rgba(150,150,150,0.2)"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          </g>
        ))}

        {COL_LABELS.map((lbl, i) => (
          <text
            key={`col-${lbl}`}
            x={PAD_L + (ZW / 3) * i + ZW / 6}
            y={PAD_T - 8}
            textAnchor="middle"
            fontSize={9}
            fill="var(--text-muted, #6b7280)"
            style={{ fontFamily: "system-ui, sans-serif" }}
          >
            {lbl}
          </text>
        ))}
        {ROW_LABELS.map((lbl, i) => (
          <text
            key={`row-${lbl}`}
            x={PAD_L - 4}
            y={PAD_T + (ZH / 3) * i + ZH / 6 + 4}
            textAnchor="end"
            fontSize={9}
            fill="var(--text-muted, #6b7280)"
            style={{ fontFamily: "system-ui, sans-serif" }}
          >
            {lbl}
          </text>
        ))}

        {pitchData.length > 0 && (
          <text
            x={releaseProj.x + 10}
            y={releaseProj.y + 3}
            textAnchor="start"
            fontSize={8}
            fill="var(--text-muted, #6b7280)"
            letterSpacing={0.6}
            style={{ fontFamily: "system-ui, sans-serif" }}
          >
            PITCHER
          </text>
        )}

        <polygon
          points={`${bx},${by} ${bx + bw},${by} ${bx + bw},${by + bh - tip} ${bx + bw / 2},${by + bh} ${bx},${by + bh - tip}`}
          fill="rgba(150,150,150,0.08)"
          stroke="rgba(150,150,150,0.3)"
          strokeWidth={1.5}
        />

        {pitchData.length > 0 && (
          <g opacity={0.8}>
            <circle cx={releaseProj.x} cy={releaseProj.y} r={7} fill="rgba(255,255,255,0.08)" />
            <circle
              cx={releaseProj.x}
              cy={releaseProj.y}
              r={3.5}
              fill="rgba(255,255,255,0.9)"
              stroke="rgba(51,65,85,0.9)"
              strokeWidth={1}
            />
            <circle cx={releaseProj.x - 0.9} cy={releaseProj.y - 0.9} r={1} fill="#ffffff" />
          </g>
        )}

        {current && animate && tube && tube.segments.length > 0 && (
          <g>
            {tube.segments.map((seg, i) => (
              <line
                key={`sh-${i}`}
                x1={seg.x1}
                y1={seg.y1 + seg.shadowOffset}
                x2={seg.x2}
                y2={seg.y2 + seg.shadowOffset}
                stroke="rgba(0,0,0,0.28)"
                strokeWidth={seg.width * 0.85}
                strokeOpacity={seg.shadowAlpha}
                strokeLinecap="round"
              />
            ))}
            {tube.segments.map((seg, i) => (
              <line
                key={`gl-${i}`}
                x1={seg.x1} y1={seg.y1}
                x2={seg.x2} y2={seg.y2}
                stroke={currentColor}
                strokeOpacity={0.2}
                strokeWidth={seg.width * 2.5}
                strokeLinecap="round"
              />
            ))}
            {tube.segments.map((seg, i) => (
              <line
                key={`core-${i}`}
                x1={seg.x1} y1={seg.y1}
                x2={seg.x2} y2={seg.y2}
                stroke={currentColor}
                strokeOpacity={seg.coreAlpha}
                strokeWidth={seg.width}
                strokeLinecap="round"
              />
            ))}
            {tube.segments.map((seg, i) => (
              <line
                key={`hi-${i}`}
                x1={seg.x1 - seg.nx}
                y1={seg.y1 - seg.ny}
                x2={seg.x2 - seg.nx}
                y2={seg.y2 - seg.ny}
                stroke="rgba(255,255,255,0.6)"
                strokeOpacity={seg.highlightAlpha}
                strokeWidth={seg.width * 0.35}
                strokeLinecap="round"
              />
            ))}
          </g>
        )}

        {tube?.ball && progress > 0 && progress < 1 && (
          <g>
            <circle cx={tube.ball.x} cy={tube.ball.y} r={14} fill={currentColor} opacity={0.22} />
            <circle
              cx={tube.ball.x}
              cy={tube.ball.y}
              r={7}
              fill="#ffffff"
              stroke={currentColor}
              strokeWidth={2.2}
            />
            <circle cx={tube.ball.x - 1.4} cy={tube.ball.y - 1.4} r={1.9} fill="rgba(255,255,255,0.95)" />
          </g>
        )}

        {current && progress >= 1 && impactMs >= 0 && impactMs < IMPACT_RING_MS + 200 && (
          <g>
            <circle
              cx={current.endProj.x}
              cy={current.endProj.y}
              r={6 + impactT * 24}
              fill="none"
              stroke={currentColor}
              strokeWidth={2.2 * (1 - impactT)}
              opacity={1 - impactT}
            />
            {impactT2 > 0 && (
              <circle
                cx={current.endProj.x}
                cy={current.endProj.y}
                r={6 + impactT2 * 18}
                fill="none"
                stroke={currentColor}
                strokeWidth={1.6 * (1 - impactT2)}
                opacity={0.75 * (1 - impactT2)}
              />
            )}
          </g>
        )}

        {pitchData.map(({ endProj, i }) => {
          const { x, y } = clampDot(endProj);
          const color = pitchDotColor(i);
          const inZone =
            endProj.x >= PAD_L && endProj.x <= PAD_L + ZW &&
            endProj.y >= PAD_T && endProj.y <= PAD_T + ZH;
          const isCurrent = current?.i === i;
          const active = isCurrent && progress >= 1;
          const pulse = active ? 1 + 0.15 * Math.max(0, 1 - impactT * 1.4) : 1;
          const dotR = 7 * pulse;
          const haloR = active ? 14 : 10;
          const haloOp = active ? 0.28 : isCurrent ? 0.22 : 0.14;

          return (
            <g key={i} opacity={isCurrent || !current ? 1 : 0.55}>
              <circle cx={x} cy={y} r={haloR} fill={color} opacity={haloOp} />
              <circle
                cx={x} cy={y}
                r={dotR + 2}
                fill="none"
                stroke={inZone ? "rgba(255,255,255,0.95)" : "rgba(240,90,90,0.95)"}
                strokeWidth={1.2}
              />
              <circle
                cx={x} cy={y}
                r={dotR}
                fill={color}
                stroke="#ffffff"
                strokeWidth={0.8}
                opacity={0.98}
              />
              <circle cx={x - 1.6} cy={y - 1.8} r={1.8} fill="rgba(255,255,255,0.55)" />
              <text
                x={x}
                y={y + 3.2}
                textAnchor="middle"
                fontSize={8}
                fill="#ffffff"
                fontWeight="bold"
                style={{ fontFamily: "system-ui, sans-serif" }}
              >
                {i + 1}
              </text>
            </g>
          );
        })}

        {pitchData.length === 0 && (
          <text
            x={W / 2}
            y={PAD_T + ZH / 2 + 4}
            textAnchor="middle"
            fontSize={12}
            fill="rgba(150,150,150,0.4)"
            style={{ fontFamily: "system-ui, sans-serif" }}
          >
            No pitches yet
          </text>
        )}

        {current && ballIsNearPlate && progress < 1 && tube?.ball && (
          <g opacity={(progress - 0.7) / 0.3}>
            {[-1, 1].map((dir) => {
              const len = 10 + 6 * ((progress - 0.7) / 0.3);
              return (
                <line
                  key={`sp-${dir}`}
                  x1={tube.ball.x - dir * 4}
                  y1={tube.ball.y - dir * 3}
                  x2={tube.ball.x - dir * (4 + len)}
                  y2={tube.ball.y - dir * (3 + len * 0.4)}
                  stroke={currentColor}
                  strokeOpacity={0.35}
                  strokeWidth={2}
                  strokeLinecap="round"
                />
              );
            })}
          </g>
        )}
      </svg>

      {pitchData.length > 0 && (
        <div className="strike-zone-legend">
          {pitchData.map(({ pitch: p, i }) => {
            const isCurrent = current?.i === i;
            return (
              <span key={i} className="strike-zone-legend-item">
                <span
                  className="strike-zone-legend-dot"
                  style={{ background: pitchDotColor(i) }}
                />
                <span className={isCurrent ? "strike-zone-legend-text strike-zone-legend-text--active" : "strike-zone-legend-text"}>
                  #{i + 1}
                  {p.pitch_type ? ` ${p.pitch_type}` : ""}
                  {p.speed_kmh ? ` · ${(p.speed_kmh * 0.621).toFixed(0)}mph` : ""}
                </span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
