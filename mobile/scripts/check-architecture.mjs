import assert from 'node:assert/strict';
import { toPitchResult } from '../src/adapters/nativeAnalysis.ts';
import { normalizePipelineProgress } from '../src/utils/pipelineStages.ts';

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

console.log('architecture checks passed');
