import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// Run the actual TS modules with only device storage replaced; no simulator needed.
function loadModule(relative, mocks = {}, cache = new Map()) {
  const filename = path.resolve(root, relative);
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} };
  cache.set(filename, module);
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true },
  }).outputText;
  runInNewContext(code, {
    ...mocks.__globals,
    module, exports: module.exports,
    require: (name) => {
      if (name in mocks) return mocks[name];
      if (!name.startsWith('.')) return require(name);
      const base = path.resolve(path.dirname(filename), name);
      const dependency = [base, `${base}.ts`, `${base}.tsx`].find(existsSync);
      return loadModule(dependency, mocks, cache);
    },
  }, { filename });
  return module.exports;
}

// Minimal hook host for lifecycle checks; native views are not rendered here.
function hookHarness() {
  const slots = [];
  let index = 0;
  let effects = [];
  const react = {
    createContext: () => ({ Provider: 'Provider' }),
    createElement: (type, props, ...children) => ({ type, props, children }),
    useCallback: (callback) => callback,
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = typeof initial === 'function' ? initial() : initial;
      return [slots[slot], (value) => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }];
    },
    useRef(initial) { return react.useState(() => ({ current: initial }))[0]; },
    useEffect(effect, deps) {
      const slot = index++;
      const previous = slots[slot];
      if (!previous || deps.some((dep, i) => !Object.is(dep, previous.deps[i]))) {
        effects.push(() => {
          previous?.cleanup?.();
          slots[slot] = { deps, cleanup: effect() };
        });
      }
    },
  };
  return {
    react,
    render(component) { index = 0; effects = []; const value = component(); effects.forEach((run) => run()); return value; },
    unmount() { slots.forEach((slot) => slot?.cleanup?.()); },
  };
}

function historyHarness() {
  let raw = null;
  let readError = false;
  let writeError = false;
  const storage = {
    async getItem() { if (readError) throw new Error('read failed'); return raw; },
    async setItem(_key, value) { if (writeError) throw new Error('write failed'); raw = value; },
    async removeItem() { if (writeError) throw new Error('write failed'); raw = null; },
  };
  return {
    ...loadModule('src/hooks/useLocalHistory.ts', { '@react-native-async-storage/async-storage': storage }),
    setRaw: (value) => { raw = value; },
    getRaw: () => raw,
    failRead: (value) => { readError = value; },
    failWrite: (value) => { writeError = value; },
  };
}

const pitch = (id, speed = 120) => ({ job_id: id, speed_info: { release_speed_kmh: speed } });

test('concurrent saves retain every pitch; reads wait for pending saves', async () => {
  const history = historyHarness();
  const saves = Array.from({ length: 6 }, (_, i) => history.saveResultToHistory(pitch(String(i))));
  const read = history.loadLocalHistory();
  await Promise.all(saves);
  assert.equal((await read).length, 6);
  assert.equal((await history.loadLocalHistory()).length, 6);
});

test('clear cannot be undone by an earlier in-flight save', async () => {
  const history = historyHarness();
  await Promise.all([history.saveResultToHistory(pitch('old')), history.clearLocalHistory()]);
  assert.equal((await history.loadLocalHistory()).length, 0);
});

test('storage errors are surfaced and never overwrite unread history', async () => {
  const history = historyHarness();
  await history.saveResultToHistory(pitch('saved'));
  const original = history.getRaw();
  history.failRead(true);
  await assert.rejects(history.saveResultToHistory(pitch('new')), /read failed/);
  assert.equal(history.getRaw(), original);
  history.failRead(false);
  history.failWrite(true);
  await assert.rejects(history.clearLocalHistory(), /write failed/);
  history.failWrite(false);
  await history.saveResultToHistory(pitch('retry'));
  assert.equal((await history.loadLocalHistory()).length, 2);
});

test('history preserves corrupt data and still supports explicit clear, deduplication and the 500-record limit', async () => {
  const history = historyHarness();
  for (const raw of ['{broken', '{}', '[null]', '[{"job_id":"bad","speed_info":[]}]']) {
    history.setRaw(raw);
    await assert.rejects(history.loadLocalHistory());
    await assert.rejects(history.saveResultToHistory(pitch('new')));
    assert.equal(history.getRaw(), raw);
  }
  await history.clearLocalHistory();
  history.setRaw(JSON.stringify(Array.from({ length: 500 }, (_, i) => pitch(String(i)))));
  await history.saveResultToHistory(pitch('new'));
  await history.saveResultToHistory(pitch('new', 130));
  const records = await history.loadLocalHistory();
  assert.equal(records.length, 500);
  assert.equal(records[0].speed_info.release_speed_kmh, 130);
  assert.equal(records.filter((record) => record.job_id === 'new').length, 1);
});

test('saved settings reject invalid calibration and discard retired or unknown fields', () => {
  const { normalizeSettings } = loadModule('src/utils/settings.ts');
  for (const raw of [null, [], 'settings', { moundDistanceM: NaN }, { moundDistanceM: 2 }, { moundDistanceM: '18.44' }]) {
    assert.equal(normalizeSettings(raw).moundDistanceM, 0);
  }
  const saved = normalizeSettings({
    moundDistanceM: 18.44, strideCorrectionM: 1.8, confThreshold: .05, speedUnit: 'kmh',
    strikeZone: { xMin: .3, xMax: .7, yMin: .4, yMax: .8 }, backendUrl: 'retired', analysisMode: 'remote',
  });
  assert.equal(saved.moundDistanceM, 18.44);
  assert.equal(saved.strideCorrectionM, 1.8);
  assert.equal(saved.strikeZone.xMin, .3);
  assert.equal('backendUrl' in saved, false);
  assert.equal('analysisMode' in saved, false);
  const invalid = normalizeSettings({ moundDistanceM: 3, strideCorrectionM: Infinity, confThreshold: -1, strikeZone: { xMin: .8, xMax: .3 } });
  assert.equal(invalid.strideCorrectionM, 0);
  assert.equal(invalid.moundDistanceM, 0);
  assert.equal(invalid.confThreshold, .03);
  assert.equal(invalid.strikeZone, null);
});

test('failed settings reads finish loading, warn once, and never write defaults over saved data', async () => {
  const hooks = hookHarness();
  const alerts = [];
  let writes = 0;
  const { SettingsProvider } = loadModule('src/context/SettingsContext.tsx', {
    react: hooks.react,
    'react-native': { View: 'View', ActivityIndicator: 'Spinner', Alert: { alert: (...args) => alerts.push(args) } },
    '@react-native-async-storage/async-storage': {
      getItem: async () => { throw new Error('storage unavailable'); },
      setItem: async () => { writes++; },
    },
  });
  assert.equal(hooks.render(() => SettingsProvider({ children: 'app' })).type, 'View');
  await new Promise(setImmediate);
  const loaded = hooks.render(() => SettingsProvider({ children: 'app' }));
  assert.equal(loaded.type, 'Provider');
  assert.equal(loaded.props.value.loaded, true);
  assert.equal(loaded.props.value.settings.moundDistanceM, 0);
  assert.equal(alerts.length, 1);
  assert.equal(writes, 0);
  hooks.unmount();
});

test('settings mount with saved calibration and persist edits in order', async () => {
  const hooks = hookHarness();
  const writes = [];
  let finishFirstWrite;
  const { SettingsProvider } = loadModule('src/context/SettingsContext.tsx', {
    react: hooks.react,
    'react-native': { View: 'View', ActivityIndicator: 'Spinner', Alert: { alert: () => assert.fail('unexpected storage error') } },
    '@react-native-async-storage/async-storage': {
      getItem: async () => JSON.stringify({ moundDistanceM: 18.44, strideCorrectionM: 1.8, speedUnit: 'kmh' }),
      setItem: async (_key, raw) => {
        writes.push(JSON.parse(raw));
        if (writes.length === 1) await new Promise((resolve) => { finishFirstWrite = resolve; });
      },
    },
  });
  const render = () => hooks.render(() => SettingsProvider({ children: 'app' }));
  render();
  await new Promise(setImmediate);
  const loaded = render().props.value;
  assert.equal(loaded.settings.moundDistanceM, 18.44);
  assert.equal(loaded.settings.strideCorrectionM, 1.8);
  assert.equal(writes.length, 0);
  loaded.updateSettings({ speedUnit: 'mph' });
  render();
  await new Promise(setImmediate);
  loaded.updateSettings({ speedUnit: 'kmh' });
  render();
  await new Promise(setImmediate);
  assert.equal(writes.length, 1);
  finishFirstWrite();
  await new Promise(setImmediate);
  assert.equal(writes.length, 2);
  assert.equal(writes[1].speedUnit, 'kmh');
  assert.equal(writes[1].moundDistanceM, 18.44);
  hooks.unmount();
});

test('replay pauses in the background without consuming the skipped wall-clock time', async () => {
  const hooks = hookHarness();
  const frames = new Map();
  let now = 0;
  let nextFrame = 0;
  let onStateChange;
  const { usePitchReplayClock } = loadModule('src/hooks/usePitchReplayClock.ts', {
    react: hooks.react,
    'react-native': {
      AccessibilityInfo: { isReduceMotionEnabled: async () => false, addEventListener: () => ({ remove() {} }) },
      AppState: { currentState: 'active', addEventListener: (_event, listener) => {
        onStateChange = listener;
        return { remove: () => { onStateChange = null; } };
      } },
    },
    __globals: {
      performance: { now: () => now },
      requestAnimationFrame: (callback) => { const id = ++nextFrame; frames.set(id, callback); return id; },
      cancelAnimationFrame: (id) => frames.delete(id),
    },
  });
  const render = () => hooks.render(() => usePitchReplayClock(10));
  render();
  await new Promise(setImmediate);
  render();
  render();
  const advance = (ms) => { now += ms; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((run) => run()); };
  advance(1000);
  assert.equal(render().progress, .05);
  onStateChange('background');
  assert.equal(frames.size, 0);
  advance(60000);
  onStateChange('active');
  advance(1000);
  assert.equal(render().progress, .1);
  hooks.unmount();
  assert.equal(frames.size, 0);
  assert.equal(onStateChange, null);
});

test('height hint never formats an absent height, even before a video is selected', () => {
  const source = readFileSync(path.join(root, 'src/screens/AnalyzeScreen.tsx'), 'utf8');
  const expression = source.match(/\{batterHeightError\s*\?[^}]+\$\{zoneHeightCm\?\.toFixed\(1\)\} cm。`/)[0].slice(1);
  const hint = runInNewContext(expression, { batterHeightError: false, needsHeight: false, hasValidBatterHeight: false, zoneHeightCm: null });
  assert.equal(hint, '輸入後即可開始分析。');
  assert.equal(runInNewContext(expression, { batterHeightError: false, needsHeight: false, hasValidBatterHeight: true, zoneHeightCm: 47.17 }), '好球帶高度約 47.2 cm。');
});

test('late metadata from a previous video cannot overwrite the newly selected video', async () => {
  const filename = path.join(root, 'src/screens/AnalyzeScreen.tsx');
  const source = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let selection;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'selectVideo') selection = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(selection);
  const module = { exports: {} };
  const requests = new Map();
  let metadata;
  const code = ts.transpileModule(`module.exports = ${selection.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, {
    module, metadataRequest: { current: 0 },
    getVideoMetadata: (uri) => new Promise((resolve, reject) => requests.set(uri, { resolve, reject })),
    setVideoMeta: (value) => { metadata = typeof value === 'function' ? value(metadata) : value; },
    setVideoUri() {}, setVideoName() {}, resetAnalysis() {}, setStatusMsg() {}, setStatusType() {},
  });
  const select = (uri) => module.exports(uri, uri, { sizeMB: '?', durationS: '?' });
  select('old');
  select('new');
  requests.get('new').resolve({ width: 1920, fps: 120 });
  requests.get('old').resolve({ width: 640, fps: 30 });
  await new Promise(setImmediate);
  assert.equal(metadata.width, 1920);
  assert.equal(metadata.fps, 120);
  select('old-failure');
  select('latest');
  requests.get('old-failure').reject(new Error('unreadable'));
  await new Promise(setImmediate);
  assert.equal(metadata.metadataPending, true);
  requests.get('latest').resolve({ fps: 240 });
  await new Promise(setImmediate);
  assert.equal(metadata.fps, 240);
  assert.equal(metadata.metadataPending, false);
});

test('invalid measurements do not poison speed statistics or plotted locations', () => {
  const conversions = loadModule('src/utils/conversions.ts');
  const coaching = loadModule('src/utils/coaching.ts');
  for (const value of [NaN, Infinity, -1, 0]) assert.equal(conversions.getSpeedKmh(pitch('bad', value)), null);
  assert.equal(conversions.getSpeedKmh({ speed_info: { release_speed_kmh: NaN, initial_speed_kmh: 110 } }), 110);
  assert.equal(conversions.formatDate('bad-date'), '');
  assert.equal(conversions.formatTime('bad-date'), '');
  assert.equal(conversions.toDateKey('bad-date'), 'Unknown');
  const records = [pitch('valid'), pitch('invalid', NaN)];
  assert.equal(coaching.buildTypeStats(records)[0].avgKmh, 120);
  assert.equal(coaching.toStrikeZonePitches([{ job_id: 'invalid', speed_info: { plate_x_norm: NaN, plate_y_norm: .5 } }]).length, 0);
  assert.equal(coaching.buildTypeStats([{ job_id: 'legacy', speed_info: { pitch_type: '__proto__' } }])[0].count, 1);
  assert.equal(conversions.pitchTypeLabel('__proto__'), '__proto__');
  assert.equal(typeof conversions.pitchColor('__proto__'), 'string');
});

test('incomplete replay timelines hold the endpoint instead of jumping back', () => {
  const { sampleAtProgress } = loadModule('src/utils/trajectoryProjection.ts');
  const { buildTunnelMetrics } = loadModule('src/utils/pitchReplay.ts');
  const points = [{ x: 0, y: 0, scale: 1, depth: 1 }, { x: 20, y: 30, scale: 1, depth: 0 }];
  assert.equal(sampleAtProgress(points, [{ t: 0 }, { t: .8 }], 1).x, 20);
  const primary = { points: [{ x: 0, y: 1, z: 10, t: 0 }, { x: .2, y: 1, z: 0, t: .8 }] };
  const comparison = { points: [{ x: 0, y: 1, z: 10, t: 0 }, { x: .4, y: 1, z: 0, t: .8 }] };
  assert.equal(buildTunnelMetrics(primary, comparison).plateSeparationCm, 20);
});

test('bullpen statistics count valid measurements only and preserve velocity trends', () => {
  const { buildBullpenMetrics } = loadModule('src/utils/sessionAnalysis.ts');
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
  const invalidSpeeds = buildBullpenMetrics([pitch('valid'), ...[NaN, Infinity, 0, -1].map((value) => pitch(String(value), value))]);
  assert.equal(invalidSpeeds.measuredCount, 1);
  assert.equal(invalidSpeeds.avgSpeedKmh, 120);
  assert.equal(buildBullpenMetrics([]).measurementRate, null);
});
