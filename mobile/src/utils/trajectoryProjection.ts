import type { PitchReplayModel, StrikeZoneGeometry } from './pitchReplay';
import type { TrajectoryWorldPoint } from '../types';

export const VIEW_W = 340;
export const VIEW_H = 430;
export const CENTER_X = VIEW_W / 2;
export const CENTER_Y = 212;

export const FOCAL = 300;
export const CAM_DIST = 14;
export const BASE_F = FOCAL / CAM_DIST;
export const HALF_DEPTH = 3.6;
export const LAT_SCALE = 1.7;
export const HEIGHT_SCALE = 1.75;
export const PIVOT_HEIGHT_M = 1.0;
export const LANE_HALF_M = 0.85;

export const MIN_ZOOM = 0.55;
export const MAX_ZOOM = 4.5;
export const YAW_SENS = 0.42;
export const PITCH_SENS = 0.34;
const MAX_GESTURE_VELOCITY = 2500;
const INERTIA_DECAY_PER_60HZ_FRAME = 0.88;

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
  /** World-space look-at point; omitted preserves the ABS projection. */
  target?: WorldPoint;
}

export interface CameraBasis {
  cYaw: number;
  sYaw: number;
  cPit: number;
  sPit: number;
  fScale: number;
  panX: number;
  panY: number;
  target?: WorldPoint;
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

export function normalizeCamera(camera: Camera): Camera {
  return {
    yaw: normalizeYaw(camera.yaw),
    pitch: clamp(camera.pitch, -8, 88),
    zoom: clamp(camera.zoom, MIN_ZOOM, MAX_ZOOM),
    panX: clamp(camera.panX, -VIEW_W, VIEW_W),
    panY: clamp(camera.panY, -VIEW_H, VIEW_H),
    ...(camera.target ? { target: camera.target } : {}),
  };
}

export function cameraVelocityFromGesture(velocityX: number, velocityY: number) {
  return {
    yaw: clamp(velocityX, -MAX_GESTURE_VELOCITY, MAX_GESTURE_VELOCITY) * YAW_SENS / 1000,
    pitch: -clamp(velocityY, -MAX_GESTURE_VELOCITY, MAX_GESTURE_VELOCITY) * PITCH_SENS / 1000,
  };
}

export function decayCameraVelocity(value: number, elapsedMs: number) {
  return value * Math.pow(INERTIA_DECAY_PER_60HZ_FRAME, clamp(elapsedMs, 0, 50) / (1000 / 60));
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
    target: cam.target,
  };
}

export function projectWorld(p: WorldPoint, distanceM: number, basis: CameraBasis): ScreenPoint {
  const zN = distanceM > 0 ? p.z / distanceM : 0;
  const sx = (p.x - (basis.target?.x ?? 0)) * LAT_SCALE;
  const sy = (p.y - (basis.target?.y ?? PIVOT_HEIGHT_M)) * HEIGHT_SCALE;
  const sz = (basis.target && distanceM > 0
    ? basis.target.z / distanceM - zN
    : 0.5 - clamp(zN, 0, 1)) * 2 * HALF_DEPTH;

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

/** Interpolate the observer, never rotate or rewrite trajectory samples. */
export function interpolateCamera(from: Camera, to: Camera, progress: number): Camera {
  const t = clamp(progress, 0, 1);
  const mix = (a: number, b: number) => a + (b - a) * t;
  return {
    yaw: lerpYaw(from.yaw, to.yaw, t),
    pitch: mix(from.pitch, to.pitch),
    zoom: mix(from.zoom, to.zoom),
    panX: mix(from.panX, to.panX),
    panY: mix(from.panY, to.panY),
    ...(from.target && to.target ? { target: {
      x: mix(from.target.x, to.target.x),
      y: mix(from.target.y, to.target.y),
      z: mix(from.target.z, to.target.z),
    } } : {}),
  };
}

export function buildReplayCameraFrames(primary: PitchReplayModel, comparisons: PitchReplayModel[], viewHeight: number) {
  const models = [primary, ...comparisons.slice(0, 5)];
  const distanceM = Math.max(...models.map((model) => model.distanceM));
  const world = buildStaticWorldScene(distanceM, primary.strikeZone);
  const target = { x: 0, y: PIVOT_HEIGHT_M, z: distanceM / 2 };
  const points = [...world.lane, ...world.strikeZone, ...models.flatMap((model) => model.points)];
  // A sphere fit keeps the entire system in frame through a full orbit.
  const radius = Math.max(1, ...points.map((point) => Math.hypot(
    (point.x - target.x) * LAT_SCALE,
    (point.y - target.y) * HEIGHT_SCALE,
    (point.z - target.z) / distanceM * 2 * HALF_DEPTH,
  )));
  const margin = 28;
  const overview: Camera = {
    ...DEFAULT_CAMERA,
    yaw: 135,
    pitch: 24,
    zoom: clamp((Math.min(VIEW_W, viewHeight) / 2 - margin) * Math.sqrt(Math.max(1, CAM_DIST ** 2 - radius ** 2)) / (FOCAL * radius), MIN_ZOOM, 2.05),
    panY: viewHeight / 2 - CENTER_Y,
    target,
  };
  const zone: Camera = {
    ...overview,
    yaw: 180,
    pitch: 6,
    zoom: 1,
    target: { x: 0, y: primary.strikeZone.centerYM, z: 0 },
  };
  const basis = buildCameraBasis(zone);
  const outcomes = [...world.strikeZone, ...models.flatMap((model) => model.landingPoint ? [model.landingPoint] : [])]
    .map((point) => projectWorld(point, distanceM, basis));
  const halfWidth = Math.max(1, ...outcomes.map((point) => Math.abs(point.x - CENTER_X)));
  const halfHeight = Math.max(1, ...outcomes.map((point) => Math.abs(point.y - viewHeight / 2)));
  zone.zoom = Math.min(7, (VIEW_W / 2 - margin) / halfWidth, (viewHeight / 2 - margin) / halfHeight);
  return { overview, zone, distanceM };
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
  if (points.length === 1) return `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  const commands = [`M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`];
  for (let index = 1; index < points.length - 1; index++) {
    const point = points[index];
    const next = points[index + 1];
    commands.push(
      `Q ${point.x.toFixed(1)} ${point.y.toFixed(1)} ${((point.x + next.x) / 2).toFixed(1)} ${((point.y + next.y) / 2).toFixed(1)}`,
    );
  }
  const last = points[points.length - 1];
  commands.push(`Q ${last.x.toFixed(1)} ${last.y.toFixed(1)} ${last.x.toFixed(1)} ${last.y.toFixed(1)}`);
  return commands.join(' ');
}

export function polygonPoints(points: ScreenPoint[]) {
  return points.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

export function sampleAtProgress(
  points: ScreenPoint[],
  timeline: Array<{ t: number }>,
  progress: number,
): ScreenPoint {
  if (points.length === 0) return { x: CENTER_X, y: CENTER_Y, depth: 0, scale: 1 };
  if (points.length === 1) return points[0];
  const target = clamp(progress, 0, 1);
  const next = timeline.findIndex((point) => point.t >= target);
  if (next < 0) return points[points.length - 1];
  if (next === 0) return points[0];
  const i = next - 1;
  const span = timeline[next].t - timeline[i].t;
  const local = span > 0 ? (target - timeline[i].t) / span : 0;
  const a = points[i];
  const b = points[next];
  return {
    x: a.x + (b.x - a.x) * local,
    y: a.y + (b.y - a.y) * local,
    depth: a.depth + (b.depth - a.depth) * local,
    scale: a.scale + (b.scale - a.scale) * local,
  };
}

export function pathUntilProgress(
  points: ScreenPoint[],
  timeline: Array<{ t: number }>,
  progress: number,
) {
  if (!points.length) return '';
  const target = clamp(progress, 0, 1);
  const visible = points.filter((_, index) => (timeline[index]?.t ?? 0) <= target);
  const ball = sampleAtProgress(points, timeline, target);
  return pathFrom([...visible, ball]);
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
