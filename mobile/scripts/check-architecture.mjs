import assert from 'node:assert/strict';
import { toPitchResult } from '../src/adapters/nativeAnalysis.ts';
import { normalizePipelineProgress } from '../src/utils/pipelineStages.ts';
import { buildChallengeCallout, buildPitchReplayModel } from '../src/utils/pitchReplay.ts';
import {
  buildCameraBasis,
  buildStaticWorldScene,
  pathFrom,
  projectStaticScene,
  DEFAULT_CAMERA,
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

const landingOnly = buildPitchReplayModel({
  job_id: 'landing-only',
  speed_info: { plate_x_norm: 0.5, plate_y_norm: 0.7, flight_time_s: 0.5 },
});
assert.equal(landingOnly.source, 'landing_only');
assert.equal(landingOnly.points.length, 24);
assert.equal(landingOnly.isEstimated, true);
const challengeCallout = buildChallengeCallout(landingOnly);
assert.equal(challengeCallout.point.z, 0);
assert.ok(challengeCallout.clearanceCm >= 0);

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

console.log('architecture checks passed');
