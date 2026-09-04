import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { toPitchResult } from '../src/adapters/nativeAnalysis.ts';
import { normalizePipelineProgress } from '../src/utils/pipelineStages.ts';
import { BASEBALL_RADIUS_M, buildChallengeCallout, buildPitchReplayModel, buildTunnelMetrics } from '../src/utils/pitchReplay.ts';
import {
  buildCameraBasis,
  buildReplayCameraFrames,
  buildStaticWorldScene,
  cameraVelocityFromGesture,
  decayCameraVelocity,
  pathFrom,
  projectStaticScene,
  projectWorld,
  interpolateCamera,
  normalizeYaw,
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

// Six simultaneous pitches must share one field, and all endpoints must fit the close-up.
const sixReplays = [-0.6, -0.25, -0.05, 0.1, 0.35, 0.7].map((x, index) => buildPitchReplayModel({
  job_id: `orbit-${index}`,
  speed_info: { flight_time_s: 0.3 + index * 0.06 },
  trajectory_metadata: {
    mound_distance_m: 18 + index * 0.4,
    release_point_x_m: 0.2 + index * 0.03,
    release_point_y_m: 1.9,
    release_point_z_m: 18 + index * 0.4,
    plate_crossing_x_m: x,
    plate_crossing_y_m: 0.4 + index * 0.24,
  },
}));
const beforeOrbit = JSON.stringify(sixReplays);
const primaryReplay = sixReplays[0];
const frames = buildReplayCameraFrames(primaryReplay, sixReplays.slice(1), 378);
assert.equal(frames.distanceM, Math.max(...sixReplays.map((item) => item.distanceM)));
assert.equal(frames.overview.target.z, frames.distanceM / 2);
assert.deepEqual(frames.zone.target, { x: 0, y: primaryReplay.strikeZone.centerYM, z: 0 });
assert.ok(frames.zone.zoom > frames.overview.zoom * 2);
const sharedWorld = buildStaticWorldScene(frames.distanceM, primaryReplay.strikeZone);
const inFrame = (point) => Number.isFinite(point.x) && Number.isFinite(point.y)
  && point.x >= 20 && point.x <= 320 && point.y >= 20 && point.y <= 358;
for (let yaw = -180; yaw <= 180; yaw += 30) {
  for (const pitch of [-8, 24, 60, 88]) {
    const basis = buildCameraBasis({ ...frames.overview, yaw, pitch });
    const projectedTarget = projectWorld(frames.overview.target, frames.distanceM, basis);
    assert.equal(projectedTarget.x, 170);
    assert.equal(projectedTarget.y, 189);
    for (const point of [...sharedWorld.lane, ...sharedWorld.strikeZone, ...sixReplays.flatMap((item) => item.points)]) {
      assert.ok(inFrame(projectWorld(point, frames.distanceM, basis)), `overview clipped at yaw=${yaw}, pitch=${pitch}`);
    }
  }
}
for (const point of [...sharedWorld.strikeZone, ...sixReplays.map((item) => item.landingPoint)]) {
  assert.ok(inFrame(projectWorld(point, frames.distanceM, buildCameraBasis(frames.zone))));
}
const halfwayCamera = interpolateCamera(frames.overview, frames.zone, 0.5);
assert.equal(halfwayCamera.target.z, frames.distanceM / 4);
assert.equal(interpolateCamera(frames.zone, frames.overview, 0).zoom, frames.zone.zoom);
assert.equal(normalizeYaw(interpolateCamera(frames.zone, frames.overview, 1).yaw), normalizeYaw(frames.overview.yaw));
assert.equal(JSON.stringify(sixReplays), beforeOrbit, 'camera movement mutated measured trajectories');
assert.deepEqual(buildReplayCameraFrames(primaryReplay, [...sixReplays.slice(1), outsideReplay], 378), frames);

const trajectoryScreen = readFileSync(new URL('../src/screens/TrajectorySimulationScreen.tsx', import.meta.url), 'utf8');
assert.match(trajectoryScreen, /<PitchReplay[\s\S]*?interactive/);
assert.equal(existsSync(new URL('../src/components/Trajectory3DView.tsx', import.meta.url)), false);

const pitchReplayComponent = readFileSync(new URL('../src/components/PitchReplay.tsx', import.meta.url), 'utf8');
assert.ok((pitchReplayComponent.match(/<TrajectorySceneDynamic/g) ?? []).length >= 2);
assert.match(pitchReplayComponent, /\.slice\(0, 5\)/);
assert.match(pitchReplayComponent, /comparisonModels\.map/);
assert.match(pitchReplayComponent, /color=\{pitchDotColor\(index \+ 1\)\}/);
assert.match(pitchReplayComponent, /showLandingResult=\{interactive\}/);
assert.match(pitchReplayComponent, /automaticCamera: interactive \? interactiveCamera/);
assert.match(pitchReplayComponent, /Math\.max\(model\.durationS, \.\.\.comparisonModels\.map/);
assert.match(pitchReplayComponent, /useTrajectoryProjection\(model, camera, distanceM\)/);
assert.match(pitchReplayComponent, /challenge=\{absMode\}/);
assert.match(pitchReplayComponent, /trajectoryCamera\.resumeAutomatic\(\)/);
assert.doesNotMatch(pitchReplayComponent, /const previousProjection =/);
assert.match(pitchReplayComponent, /professional-home-plate-blur\.jpg/);
assert.match(pitchReplayComponent, /Image as SvgImage/);
assert.match(pitchReplayComponent, /<SvgImage[\s\S]*?href=\{STADIUM_BACKGROUND\}[\s\S]*?preserveAspectRatio="xMidYMid slice"/);
assert.match(pitchReplayComponent, /const ABS_ZONE_BOTTOM_Y =/);
assert.match(pitchReplayComponent, /ABS_ZONE_BOTTOM_Y - projectedZoneBottom\.y/);
assert.match(pitchReplayComponent, /showHomePlate=\{!absMode\}/);
assert.match(pitchReplayComponent, /PITCHMOTION/);
assert.match(pitchReplayComponent, />ABS</);
assert.match(pitchReplayComponent, /model\.isStrike === true \? 'STRIKE'/);
assert.doesNotMatch(pitchReplayComponent, /const projectedOutcome =/);
assert.match(pitchReplayComponent, /ABS_HOME_PLATE_X - projectedZone\.x/);
assert.match(pitchReplayComponent, /const ABS_RESULT_ZOOM = 7;/);
assert.match(pitchReplayComponent, /const outcomeZoom = outside[^;]*: ABS_RESULT_ZOOM;/);
assert.match(pitchReplayComponent, /id="resultGlow"/);
assert.match(pitchReplayComponent, /fill="url\(#resultGlow\)"/);
assert.match(pitchReplayComponent, /const ballRadius = 4\.5;/);
assert.doesNotMatch(pitchReplayComponent, /ballRadius = 4\.5 \+ resultProgress/);
assert.equal(existsSync(new URL('../assets/replay/professional-home-plate-blur.jpg', import.meta.url)), true);

const dynamicTrajectory = readFileSync(new URL('../src/components/trajectory/TrajectorySceneDynamic.tsx', import.meta.url), 'utf8');
assert.match(dynamicTrajectory, /const shadowPath = challenge \? '' : pathUntilProgress/);

const guidedCapture = readFileSync(new URL('../src/components/GuidedCaptureModal.tsx', import.meta.url), 'utf8');
assert.match(guidedCapture, /autofocus="on"/);

const sessionDetailScreen = readFileSync(new URL('../src/screens/SessionDetailScreen.tsx', import.meta.url), 'utf8');
assert.match(sessionDetailScreen, /selected\.length < 6/);
assert.match(sessionDetailScreen, /comparisonPitches: selectedPitches\.slice\(1\)/);

console.log('architecture checks passed');
