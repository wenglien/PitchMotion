import { StrikeZoneGeometry } from './trajectory3d';
import { TrajectoryWorldPoint } from '../types';

export const VIEW_W = 340;
export const VIEW_H = 430;
export const CENTER_X = VIEW_W / 2;
export const CENTER_Y = 212;

export const FOCAL = 300;
export const CAM_DIST = 14;
export const BASE_F = FOCAL / CAM_DIST;
export const HALF_DEPTH = 3.6;
export const LAT_SCALE = 1.7;
export const HEIGHT_SCALE = 1.5;
export const PIVOT_HEIGHT_M = 1.0;
export const LANE_HALF_M = 0.85;

export const MIN_ZOOM = 0.55;
export const MAX_ZOOM = 4.5;
export const YAW_SENS = 0.42;
export const PITCH_SENS = 0.34;

export interface WorldPoint {
  x: number;
  y: number;
  z: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
  depth: number;
  scale: number;
}

export interface Camera {
  yaw: number;
  pitch: number;
  zoom: number;
  panX: number;
  panY: number;
}

export interface CameraBasis {
  cYaw: number;
  sYaw: number;
  cPit: number;
  sPit: number;
  fScale: number;
  panX: number;
  panY: number;
}

export interface ViewPreset {
  id: string;
  label: string;
  yaw: number;
  pitch: number;
}

export const VIEW_PRESETS: ViewPreset[] = [
  { id: 'catcher', label: '捕手', yaw: 0, pitch: 18 },
  { id: 'side', label: '側面', yaw: 90, pitch: 12 },
  { id: 'top', label: '俯視', yaw: 0, pitch: 82 },
  { id: 'pitcher', label: '投手', yaw: 180, pitch: 18 },
];

export const DEFAULT_CAMERA: Camera = {
  yaw: VIEW_PRESETS[0].yaw,
  pitch: VIEW_PRESETS[0].pitch,
  zoom: 1,
  panX: 0,
  panY: 0,
};

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

/** Keep yaw in a stable range so long drags don't accumulate huge angles. */
export function normalizeYaw(yaw: number) {
  let y = yaw % 360;
  if (y > 180) y -= 360;
  if (y < -180) y += 360;
  return y;
}

/** Shortest arc interpolation — catcher→pitcher goes through ±180, not 540°. */
export function lerpYaw(from: number, to: number, t: number) {
  const delta = ((to - from + 540) % 360) - 180;
  return normalizeYaw(from + delta * t);
}

function toRad(deg: number) {
  return (deg * Math.PI) / 180;
}

export function buildCameraBasis(cam: Camera): CameraBasis {
  const yaw = toRad(cam.yaw);
  const pitch = toRad(cam.pitch);
  return {
    cYaw: Math.cos(yaw),
    sYaw: Math.sin(yaw),
    cPit: Math.cos(pitch),
    sPit: Math.sin(pitch),
    fScale: FOCAL * cam.zoom,
    panX: cam.panX,
    panY: cam.panY,
  };
}

export function projectWorld(p: WorldPoint, distanceM: number, basis: CameraBasis): ScreenPoint {
  const zN = distanceM > 0 ? clamp(p.z / distanceM, 0, 1) : 0;
  const sx = p.x * LAT_SCALE;
  const sy = (p.y - PIVOT_HEIGHT_M) * HEIGHT_SCALE;
  const sz = (0.5 - zN) * 2 * HALF_DEPTH;

  const x1 = sx * basis.cYaw + sz * basis.sYaw;
  const z1 = -sx * basis.sYaw + sz * basis.cYaw;
  const y1 = sy;

  const y2 = y1 * basis.cPit - z1 * basis.sPit;
  const z2 = y1 * basis.sPit + z1 * basis.cPit;
  const x2 = x1;

  const denom = Math.max(CAM_DIST - z2, 0.6);
  const f = basis.fScale / denom;
  return {
    x: CENTER_X + basis.panX + x2 * f,
    y: CENTER_Y + basis.panY - y2 * f,
    depth: z2,
    scale: f / BASE_F,
  };
}

export function ground(x: number, z: number): WorldPoint {
  return { x, y: 0, z };
}

export function projectPoints(
  points: TrajectoryWorldPoint[],
  distanceM: number,
  basis: CameraBasis,
): ScreenPoint[] {
  return points.map((point) => projectWorld(point, distanceM, basis));
}

export function pathFrom(points: ScreenPoint[]) {
  if (!points.length) return '';
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(' ');
}

export function polygonPoints(points: ScreenPoint[]) {
  return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

export function sampleAtProgress(points: ScreenPoint[], progress: number): ScreenPoint {
  if (points.length === 0) return { x: CENTER_X, y: CENTER_Y, depth: 0, scale: 1 };
  if (points.length === 1) return points[0];
  const raw = clamp(progress, 0, 1) * (points.length - 1);
  const i = Math.floor(raw);
  const next = Math.min(points.length - 1, i + 1);
  const local = raw - i;
  const a = points[i];
  const b = points[next];
  return {
    x: a.x + (b.x - a.x) * local,
    y: a.y + (b.y - a.y) * local,
    depth: a.depth + (b.depth - a.depth) * local,
    scale: a.scale + (b.scale - a.scale) * local,
  };
}

export function buildTrajectorySegments(
  projected: ScreenPoint[],
  curvePoints: Array<{ confidence?: number; is_synthetic?: boolean }>,
  maxSegments = 20,
) {
  const segments: Array<{ d: string; width: number; opacity: number; dashed: boolean }> = [];
  if (projected.length < 2) return segments;
  const step = Math.max(1, Math.ceil((projected.length - 1) / maxSegments));
  for (let i = 0; i < projected.length - 1; i += step) {
    const end = Math.min(projected.length - 1, i + step);
    let scaleSum = 0;
    let count = 0;
    let lowConf = 0;
    let d = `M ${projected[i].x.toFixed(1)} ${projected[i].y.toFixed(1)}`;
    for (let j = i + 1; j <= end; j++) {
      d += ` L ${projected[j].x.toFixed(1)} ${projected[j].y.toFixed(1)}`;
      scaleSum += projected[j].scale;
      count += 1;
      const conf = curvePoints[j]?.confidence ?? (curvePoints[j]?.is_synthetic ? 0.45 : 1);
      if (conf < 0.7) lowConf += 1;
    }
    const scale = count ? scaleSum / count : projected[i].scale;
    segments.push({
      d,
      width: 2.0 + scale * 2.2,
      opacity: 0.42 + clamp(scale, 0.3, 1.4) * 0.4,
      dashed: lowConf > count / 2,
    });
  }
  return segments;
}

export interface StaticWorldScene {
  lane: WorldPoint[];
  laneNearLeft: WorldPoint;
  laneNearRight: WorldPoint;
  laneFarLeft: WorldPoint;
  laneFarRight: WorldPoint;
  strikeZone: WorldPoint[];
  zoneHLines: Array<{ left: WorldPoint; right: WorldPoint }>;
  zoneVLines: Array<{ bottom: WorldPoint; top: WorldPoint }>;
  homePlate: WorldPoint[];
  moundPt: WorldPoint;
  platePt: WorldPoint;
  xGrid: Array<{ x: number; near: WorldPoint; far: WorldPoint }>;
  zTicks: Array<{ ratio: number; z: number; left: WorldPoint; right: WorldPoint }>;
}

export function buildStaticWorldScene(distanceM: number, strikeZone: StrikeZoneGeometry): StaticWorldScene {
  const strikeLeft = -strikeZone.halfWidthM;
  const strikeRight = strikeZone.halfWidthM;
  const strikeBottom = strikeZone.centerYM - strikeZone.halfHeightM;
  const strikeTop = strikeZone.centerYM + strikeZone.halfHeightM;

  return {
    lane: [
      ground(-LANE_HALF_M, 0),
      ground(LANE_HALF_M, 0),
      ground(LANE_HALF_M, distanceM),
      ground(-LANE_HALF_M, distanceM),
    ],
    laneNearLeft: ground(-LANE_HALF_M, 0),
    laneNearRight: ground(LANE_HALF_M, 0),
    laneFarLeft: ground(-LANE_HALF_M, distanceM),
    laneFarRight: ground(LANE_HALF_M, distanceM),
    strikeZone: [
      { x: strikeLeft, y: strikeBottom, z: 0 },
      { x: strikeRight, y: strikeBottom, z: 0 },
      { x: strikeRight, y: strikeTop, z: 0 },
      { x: strikeLeft, y: strikeTop, z: 0 },
    ],
    zoneHLines: [0.33, 0.66].map((v) => ({
      left: { x: strikeLeft, y: strikeBottom + (strikeTop - strikeBottom) * v, z: 0 },
      right: { x: strikeRight, y: strikeBottom + (strikeTop - strikeBottom) * v, z: 0 },
    })),
    zoneVLines: [0.33, 0.66].map((v) => ({
      bottom: { x: strikeLeft + (strikeRight - strikeLeft) * v, y: strikeBottom, z: 0 },
      top: { x: strikeLeft + (strikeRight - strikeLeft) * v, y: strikeTop, z: 0 },
    })),
    homePlate: [
      ground(-0.22, 0),
      ground(0.22, 0),
      ground(0.16, 0.42),
      ground(0, 0.62),
      ground(-0.16, 0.42),
    ],
    moundPt: ground(0, distanceM),
    platePt: ground(0, 0),
    xGrid: [-0.6, -0.3, 0, 0.3, 0.6].map((x) => ({
      x,
      near: ground(x, 0),
      far: ground(x, distanceM),
    })),
    zTicks: [0.2, 0.4, 0.6, 0.8].map((ratio) => {
      const z = distanceM * ratio;
      return {
        ratio,
        z,
        left: ground(-LANE_HALF_M, z),
        right: ground(LANE_HALF_M, z),
      };
    }),
  };
}

export function projectStaticScene(world: StaticWorldScene, distanceM: number, basis: CameraBasis) {
  const project = (p: WorldPoint) => projectWorld(p, distanceM, basis);
  return {
    lane: world.lane.map(project),
    laneNearLeft: project(world.laneNearLeft),
    laneNearRight: project(world.laneNearRight),
    laneFarLeft: project(world.laneFarLeft),
    laneFarRight: project(world.laneFarRight),
    strikeZone: world.strikeZone.map(project),
    zoneHLines: world.zoneHLines.map((line) => ({
      left: project(line.left),
      right: project(line.right),
    })),
    zoneVLines: world.zoneVLines.map((line) => ({
      bottom: project(line.bottom),
      top: project(line.top),
    })),
    homePlate: world.homePlate.map(project),
    moundPt: project(world.moundPt),
    platePt: project(world.platePt),
    xGrid: world.xGrid.map((line) => ({
      x: line.x,
      near: project(line.near),
      far: project(line.far),
    })),
    zTicks: world.zTicks.map((tick) => ({
      ratio: tick.ratio,
      z: tick.z,
      left: project(tick.left),
      right: project(tick.right),
    })),
  };
}

export function zoomAroundFocal(
  start: Camera,
  nextZoom: number,
  focalX: number,
  focalY: number,
): Pick<Camera, 'zoom' | 'panX' | 'panY'> {
  const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
  const ratio = zoom / start.zoom;
  return {
    zoom,
    panX: start.panX + (focalX - CENTER_X) * (1 - ratio),
    panY: start.panY + (focalY - CENTER_Y) * (1 - ratio),
  };
}
