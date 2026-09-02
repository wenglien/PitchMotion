import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { toPitchResult } from '../src/adapters/nativeAnalysis.ts';
import { normalizePipelineProgress } from '../src/utils/pipelineStages.ts';
import { BASEBALL_RADIUS_M, buildChallengeCallout, buildPitchReplayModel, buildTunnelMetrics } from '../src/utils/pitchReplay.ts';
import { buildBullpenMetrics } from '../src/utils/sessionAnalysis.ts';
import {
  buildCameraBasis,
  buildStaticWorldScene,
  cameraVelocityFromGesture,
  decayCameraVelocity,
  pathFrom,
  projectStaticScene,
  DEFAULT_CAMERA,
  normalizeCamera,
} from '../src/utils/trajectoryProjection.ts';

const result = toPitchResult({
  job_id: 'job-1',
  overlay_uri: 'file:///overlay.mp4',
  speed_info: { release_speed_kmh: 150, mound_distance_m: 18.44 },
  trajectory_points_norm: [{ x: 0.2, y: 0.3 }],
});

assert.equal(result.job_id, 'job-1');
assert.equal(result.speed_info.release_speed_kmh, 150);
assert.equal(result.overlay_url, 'file:///overlay.mp4');
assert.equal('mound_distance_m' in result.speed_info, false);
assert.deepEqual(result.trajectory_points_norm, [{ x: 0.2, y: 0.3 }]);
assert.throws(() => toPitchResult({ error: 'native failed' }), /native failed/);

assert.deepEqual(
  normalizePipelineProgress({ stage: 'detecting', progress: 0.5, message: '' }),
  { stageId: 'detection', message: '處理中…', pct: 25 },
);
assert.deepEqual(
  normalizePipelineProgress({ stage: 'calculating', progress: 0.65, message: 'Speed' }),
  { stageId: 'speed', message: 'Speed', pct: 63 },
);
assert.deepEqual(
  normalizePipelineProgress({ stage: 'done', progress: 1, message: 'Analysis complete' }),
  { stageId: 'done', message: 'Analysis complete', pct: 100 },
);

const measuredPitch = {
  job_id: 'measured',
  speed_info: {
    pitch_type: 'Fastball',
    plate_x_norm: 0.55,
    plate_y_norm: 0.72,
    release_time_s: 1,
    catch_time_s: 1.4,
  },
  trajectory_samples: [
    { frame_index: 10, t_s: 1, x_norm: 0.48, y_norm: 0.4, is_synthetic: false },
    { frame_index: 11, t_s: 1.1, x_norm: 0.5, y_norm: 0.5, is_synthetic: false },
    { frame_index: 14, t_s: 1.4, x_norm: 0.54, y_norm: 0.7, is_synthetic: false },
  ],
};
const replay = buildPitchReplayModel(measuredPitch);
assert.ok(Math.abs(replay.durationS - 0.4) < 1e-9);
assert.ok(Math.abs(replay.points.find((point) => point.frame_index === 11).t - 0.25) < 1e-9);
assert.deepEqual(replay.points.slice(-1).map(({ t, z }) => ({ t, z })), [{ t: 1, z: 0 }]);
assert.equal(replay.isEstimated, true);

const otherTypeReplay = buildPitchReplayModel({
  ...measuredPitch,
  speed_info: { ...measuredPitch.speed_info, pitch_type: 'Curveball' },
});
assert.deepEqual(replay.points, otherTypeReplay.points);

const tunnel = buildTunnelMetrics(replay, buildPitchReplayModel({
  ...measuredPitch,
  job_id: 'tunnel-comparison',
  speed_info: { ...measuredPitch.speed_info, plate_x_norm: 0.65 },
}));
assert.ok(tunnel);
assert.ok(Number.isFinite(tunnel.midpointSeparationCm));
assert.ok(tunnel.plateSeparationCm > 0);

const bullpen = buildBullpenMetrics([
  { job_id: '1', created_at: '2026-01-01T00:00:01Z', speed_info: { release_speed_kmh: 100, is_strike: true } },
  { job_id: '2', created_at: '2026-01-01T00:00:02Z', speed_info: { release_speed_kmh: 110, is_strike: false } },
  { job_id: '3', created_at: '2026-01-01T00:00:03Z', speed_info: { release_speed_kmh: 90, is_strike: true } },
  { job_id: '4', created_at: '2026-01-01T00:00:04Z', speed_info: { release_speed_kmh: 80 } },
]);
assert.equal(bullpen.avgSpeedKmh, 95);
assert.equal(bullpen.velocityDeltaKmh, -20);
assert.equal(bullpen.strikeRate, 2 / 3);
assert.equal(bullpen.measurementRate, 1);

const calibratedReplay = buildPitchReplayModel({
  ...measuredPitch,
  job_id: 'calibrated-world-endpoints',
  trajectory_metadata: {
    release_point_x_m: 0.22,
    release_point_y_m: 1.92,
    release_point_z_m: 18.1,
    plate_crossing_x_m: -0.08,
    plate_crossing_y_m: 0.76,
  },
});
assert.ok(Math.abs(calibratedReplay.points[0].x - 0.22) < 1e-9);
assert.ok(Math.abs(calibratedReplay.points[0].y - 1.92) < 1e-9);
assert.ok(Math.abs(calibratedReplay.points[0].z - 18.1) < 1e-9);
assert.ok(Math.abs(calibratedReplay.landingPoint.x + 0.08) < 1e-9);
assert.ok(Math.abs(calibratedReplay.landingPoint.y - 0.76) < 1e-9);

const jaggedReplay = buildPitchReplayModel({
  job_id: 'jagged',
  speed_info: { plate_x_norm: 0.55, plate_y_norm: 0.72, release_time_s: 0, catch_time_s: 0.5 },
  trajectory_samples: [
    { frame_index: 0, t_s: 0, x_norm: 0.5, y_norm: 0.36, is_synthetic: false },
    { frame_index: 1, t_s: 0.1, x_norm: 0.7, y_norm: 0.5, is_synthetic: false },
    { frame_index: 2, t_s: 0.2, x_norm: 0.3, y_norm: 0.42, is_synthetic: false },
    { frame_index: 3, t_s: 0.3, x_norm: 0.68, y_norm: 0.65, is_synthetic: false },
    { frame_index: 4, t_s: 0.4, x_norm: 0.35, y_norm: 0.58, is_synthetic: false },
    { frame_index: 5, t_s: 0.5, x_norm: 0.55, y_norm: 0.72, is_synthetic: false },
  ],
});
const roughness = (axis) => jaggedReplay.points.slice(1, -1).reduce((sum, point, index) => (
  sum + Math.abs(jaggedReplay.points[index][axis] - 2 * point[axis] + jaggedReplay.points[index + 2][axis])
), 0);
assert.ok(roughness('x') < 0.3 && roughness('y') < 0.3);

const outlierReplay = buildPitchReplayModel({
  job_id: 'single-outlier',
  speed_info: { plate_x_norm: 0.52, plate_y_norm: 0.7, flight_time_s: 0.5 },
  trajectory_samples: Array.from({ length: 21 }, (_, index) => ({
    frame_index: index,
    t_s: index / 40,
    x_norm: index === 10 ? 0.98 : 0.48 + index * 0.002,
    y_norm: index === 10 ? 0.18 : 0.34 + index * 0.018,
    is_synthetic: false,
  })),
});
const cleanReplay = buildPitchReplayModel({
  job_id: 'clean-reference',
  speed_info: { plate_x_norm: 0.52, plate_y_norm: 0.7, flight_time_s: 0.5 },
  trajectory_samples: Array.from({ length: 21 }, (_, index) => ({
    frame_index: index,
    t_s: index / 40,
    x_norm: 0.48 + index * 0.002,
    y_norm: 0.34 + index * 0.018,
    is_synthetic: false,
  })),
});
const maxOutlierDeviation = Math.max(...outlierReplay.points.map((point, index) => Math.hypot(
  point.x - cleanReplay.points[index].x,
  point.y - cleanReplay.points[index].y,
)));
assert.ok(maxOutlierDeviation < 0.15, `single detection outlier bent replay by ${maxOutlierDeviation.toFixed(3)}m`);

const landingOnly = buildPitchReplayModel({
  job_id: 'landing-only',
  speed_info: { plate_x_norm: 0.5, plate_y_norm: 0.7, flight_time_s: 0.5 },
});
assert.equal(landingOnly.source, 'landing_only');
assert.equal(landingOnly.points.length, 24);
assert.equal(landingOnly.isEstimated, true);
const challengeCallout = buildChallengeCallout(landingOnly);
assert.equal(challengeCallout.point.z, 0);
assert.equal(challengeCallout.inside, true);

const outsideReplay = buildPitchReplayModel({
  job_id: 'outside-zone',
  speed_info: { plate_x_norm: 0.95, plate_y_norm: 0.7, flight_time_s: 0.5 },
});
const outsideCallout = buildChallengeCallout(outsideReplay);
assert.equal(outsideCallout.inside, false);
assert.ok(outsideCallout.clearanceCm > 0);
const outsideCenterClearanceM = Math.hypot(
  outsideCallout.point.x - outsideReplay.landingPoint.x,
  outsideCallout.point.y - outsideReplay.landingPoint.y,
);
assert.ok(Math.abs(outsideCallout.clearanceCm - (outsideCenterClearanceM - BASEBALL_RADIUS_M) * 100) < 1e-9);

const challengeScene = projectStaticScene(
  buildStaticWorldScene(landingOnly.distanceM, landingOnly.strikeZone),
  landingOnly.distanceM,
  buildCameraBasis({ ...DEFAULT_CAMERA, pitch: 5, zoom: 2.05 }),
);
const challengeZoneWidth = Math.max(...challengeScene.strikeZone.map((point) => point.x))
  - Math.min(...challengeScene.strikeZone.map((point) => point.x));
const challengeZoneHeight = Math.max(...challengeScene.strikeZone.map((point) => point.y))
  - Math.min(...challengeScene.strikeZone.map((point) => point.y));
assert.ok(challengeZoneWidth > 40 && challengeZoneWidth < 50);
assert.ok(challengeZoneHeight > 55 && challengeZoneHeight < 70);

const smoothPath = pathFrom([
  { x: 0, y: 0, depth: 0, scale: 1 },
  { x: 10, y: 16, depth: 0, scale: 1 },
  { x: 20, y: 10, depth: 0, scale: 1 },
]);
assert.equal(smoothPath, 'M 0.0 0.0 Q 10.0 16.0 15.0 13.0 Q 20.0 10.0 20.0 10.0');

assert.deepEqual(
  normalizeCamera({ yaw: 725, pitch: 120, zoom: 99, panX: 999, panY: -999 }),
  { yaw: 5, pitch: 88, zoom: 4.5, panX: 340, panY: -430 },
);
const velocity = cameraVelocityFromGesture(10_000, -10_000);
assert.ok(Math.abs(velocity.yaw - 1.05) < 1e-9 && Math.abs(velocity.pitch - 0.85) < 1e-9);
const fullFrameDecay = decayCameraVelocity(1, 1000 / 60);
const twoHalfFrameDecay = decayCameraVelocity(decayCameraVelocity(1, 1000 / 120), 1000 / 120);
assert.ok(Math.abs(fullFrameDecay - twoHalfFrameDecay) < 1e-12);

const trajectoryScreen = readFileSync(new URL('../src/screens/TrajectorySimulationScreen.tsx', import.meta.url), 'utf8');
assert.match(trajectoryScreen, /<PitchReplay[\s\S]*?interactive/);
assert.equal(existsSync(new URL('../src/components/Trajectory3DView.tsx', import.meta.url)), false);

const pitchReplayComponent = readFileSync(new URL('../src/components/PitchReplay.tsx', import.meta.url), 'utf8');
assert.ok((pitchReplayComponent.match(/<TrajectorySceneDynamic/g) ?? []).length >= 2);
assert.match(pitchReplayComponent, /\.slice\(0, 5\)/);
assert.match(pitchReplayComponent, /comparisonModels\.map/);
assert.match(pitchReplayComponent, /color=\{pitchDotColor\(index \+ 1\)\}/);
assert.match(pitchReplayComponent, /showLandingResult=\{comparisonMode\}/);

const sessionDetailScreen = readFileSync(new URL('../src/screens/SessionDetailScreen.tsx', import.meta.url), 'utf8');
assert.match(sessionDetailScreen, /selected\.length < 6/);
assert.match(sessionDetailScreen, /comparisonPitches: selectedPitches\.slice\(1\)/);

console.log('architecture checks passed');
