import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import { GestureDetector } from 'react-native-gesture-handler';
import Svg, {
  Circle,
  Defs,
  G,
  LinearGradient,
  Line,
  Path,
  Polygon,
  RadialGradient,
  Rect,
  Stop,
  Text as SvgText,
} from 'react-native-svg';
import { PitchResult } from '../types';
import { Colors, Radius, Spacing } from '../theme';
import { formatSpeed, pitchColor, pitchDotColor, pitchTypeLabel, speedUnitLabel } from '../utils/conversions';
import { PITCH_REPLAY_SCALE, buildChallengeCallout, buildPitchReplayModel } from '../utils/pitchReplay';
import type { PitchReplayModel } from '../utils/pitchReplay';
import {
  buildCameraBasis,
  CENTER_X,
  CENTER_Y,
  DEFAULT_CAMERA,
  lerpYaw,
  projectWorld,
  VIEW_W,
} from '../utils/trajectoryProjection';
import type { Camera } from '../utils/trajectoryProjection';
import { usePitchReplayClock } from '../hooks/usePitchReplayClock';
import { useTrajectoryCamera } from '../hooks/useTrajectoryCamera';
import { useTrajectoryProjection } from '../hooks/useTrajectoryProjection';
import { useSettings } from '../context/SettingsContext';
import TrajectorySceneDynamic from './trajectory/TrajectorySceneDynamic';
import TrajectorySceneStatic from './trajectory/TrajectorySceneStatic';

const CAMERA_ROTATION_S = 1.6;
const RESULT_REVEAL_S = 1.1;
const CHALLENGE_TRAIL = '#ec4899';
const CHALLENGE_H = 378;
const HOME_PLATE_ANCHOR_Y = 360;
const BASEBALL_STITCHES = [-0.58, -0.3, 0, 0.3, 0.58];
const STADIUM_BACKGROUND = require('../../assets/replay/mound-to-home-plate.jpg');
const INTERACTIVE_CAMERA = { ...DEFAULT_CAMERA, pitch: 5, zoom: 2.05 };

interface Props {
  pitch: PitchResult;
  previousPitch?: PitchResult | null;
  comparisonPitches?: PitchResult[];
  interactive?: boolean;
  onGestureActiveChange?: (active: boolean) => void;
}

function TunnelTrajectory({ model, camera, progress, color }: {
  model: PitchReplayModel;
  camera: Camera;
  progress: number;
  color: string;
}) {
  const projection = useTrajectoryProjection(model, camera);
  return (
    <TrajectorySceneDynamic
      pitchColor={color}
      progress={progress}
      timeline={projection.timeline}
      projected={projection.projected}
      shadowProjected={projection.shadowProjected}
      landingProjected={projection.landingProjected}
      landingShadow={projection.landingShadow}
      isStrike={model.isStrike}
      showLandingResult
      challenge
    />
  );
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function smooth(value: number) {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function arrowHead(x: number, y: number, dx: number, dy: number, size = 7) {
  const px = -dy;
  const py = dx;
  return `${x},${y} ${x - dx * size + px * size * 0.45},${y - dy * size + py * size * 0.45} ${x - dx * size - px * size * 0.45},${y - dy * size - py * size * 0.45}`;
}

export default function PitchReplay({
  pitch,
  previousPitch = null,
  comparisonPitches,
  interactive = false,
  onGestureActiveChange,
}: Props) {
  const isFocused = useIsFocused();
  const { settings } = useSettings();
  const [showPrevious, setShowPrevious] = useState(previousPitch != null);
  const timelineWidthRef = useRef(VIEW_W);
  const model = useMemo(() => buildPitchReplayModel(pitch), [pitch]);
  const comparisonModels = useMemo(
    () => (comparisonPitches?.length ? comparisonPitches : previousPitch ? [previousPitch] : [])
      .slice(0, 5)
      .map(buildPitchReplayModel),
    [comparisonPitches, previousPitch],
  );
  const previousModel = comparisonModels[0] ?? null;
  const flightDurationS = model.durationS * PITCH_REPLAY_SCALE;
  const totalDurationS = flightDurationS + (interactive ? 0 : CAMERA_ROTATION_S) + RESULT_REVEAL_S;
  const clock = usePitchReplayClock(totalDurationS, isFocused);
  const handleGestureActiveChange = useCallback((active: boolean) => {
    if (active) clock.pause();
    onGestureActiveChange?.(active);
  }, [clock.pause, onGestureActiveChange]);
  const trajectoryCamera = useTrajectoryCamera({
    enabled: interactive,
    initialCamera: interactive ? INTERACTIVE_CAMERA : undefined,
    onGestureActiveChange: handleGestureActiveChange,
  });
  const elapsedS = clock.progress * totalDurationS;
  const ballProgress = clamp01(elapsedS / flightDurationS);
  const cameraRotationProgress = interactive ? 0 : clamp01((elapsedS - flightDurationS) / CAMERA_ROTATION_S);
  const resultProgress = smooth((elapsedS - flightDurationS - (interactive ? 0 : CAMERA_ROTATION_S)) / RESULT_REVEAL_S);
  const edge = useMemo(() => buildChallengeCallout(model), [model]);

  const animatedCamera = useMemo(() => {
    const approachFocus = smooth((ballProgress - 0.72) / 0.28);
    const zoneFocus = approachFocus * (1 - resultProgress);
    const outside = edge && !edge.inside && model.landingPoint
      ? { edge: edge.point, landing: model.landingPoint }
      : null;
    const centerClearanceM = outside
      ? Math.hypot(outside.edge.x - outside.landing.x, outside.edge.y - outside.landing.y)
      : 0;
    const closeZoom = 2.05 + ballProgress * 0.2 + approachFocus * 1.6;
    const outcomeZoom = outside ? Math.max(8, Math.min(24, 3.6 / centerClearanceM)) : 10;
    const base = {
      ...DEFAULT_CAMERA,
      yaw: lerpYaw(0, 180, cameraRotationProgress),
      pitch: 5 - resultProgress * 2,
      zoom: closeZoom + resultProgress * (outcomeZoom - closeZoom),
      panX: 0,
      panY: 0,
    };
    const basis = buildCameraBasis(base);
    const projectedZone = projectWorld({ x: 0, y: model.strikeZone.centerYM, z: 0 }, model.distanceM, basis);
    const projectedPlate = projectWorld({ x: 0, y: 0, z: 0 }, model.distanceM, basis);
    const projectedOutcome = outside
      ? projectWorld({
        x: (outside.edge.x + outside.landing.x) / 2,
        y: (outside.edge.y + outside.landing.y) / 2,
        z: 0,
      }, model.distanceM, basis)
      : projectedPlate;
    return {
      ...base,
      panX: (CENTER_X - projectedZone.x) * zoneFocus + (CENTER_X - projectedOutcome.x) * resultProgress,
      panY: (CENTER_Y - projectedZone.y) * zoneFocus
        + ((outside ? CENTER_Y : HOME_PLATE_ANCHOR_Y) - projectedOutcome.y) * resultProgress,
    };
  }, [ballProgress, cameraRotationProgress, edge, model, resultProgress]);
  const camera = interactive ? trajectoryCamera.camera : animatedCamera;

  const projection = useTrajectoryProjection(model, camera);
  const previousProjection = useTrajectoryProjection(previousModel ?? model, camera);
  const edgeProjected = useMemo(
    () => edge ? projectWorld(edge.point, model.distanceM, buildCameraBasis(camera)) : null,
    [camera, edge, model.distanceM],
  );
  const type = pitch.speed_info?.pitch_type;
  const comparisonMode = interactive && comparisonModels.length > 0;
  const previousColor = pitchColor(previousPitch?.speed_info?.pitch_type ?? '');
  const speedKmh = pitch.speed_info?.release_speed_kmh ?? pitch.speed_info?.initial_speed_kmh;
  const verdict = model.isStrike === true ? '好球' : model.isStrike === false ? '壞球' : '落點確認';
  const landing = projection.landingProjected;
  const measureDx = landing && edgeProjected ? edgeProjected.x - landing.x : 0;
  const measureDy = landing && edgeProjected ? edgeProjected.y - landing.y : 0;
  const measureLength = Math.hypot(measureDx, measureDy);
  const measureUx = measureLength > 0 ? measureDx / measureLength : 0;
  const measureUy = measureLength > 0 ? measureDy / measureLength : -1;
  const resultOpacity = clamp01((resultProgress - 0.25) / 0.45);
  const ballRadius = 4.5 + resultProgress * 9.5;
  const measureStartOffset = ballRadius;
  const measureStartX = (landing?.x ?? 0) + measureUx * measureStartOffset;
  const measureStartY = (landing?.y ?? 0) + measureUy * measureStartOffset;
  const measureLabelX = Math.max(34, Math.min(VIEW_W - 34,
    (measureStartX + (edgeProjected?.x ?? 0)) / 2 - measureUy * 26));
  const measureLabelY = Math.max(22, Math.min(CHALLENGE_H - 18,
    (measureStartY + (edgeProjected?.y ?? 0)) / 2 + measureUx * 26 + 5));
  return (
    <View style={styles.wrap}>
      <View style={styles.hud}>
        <View>
          <Text style={styles.hudLabel}>{comparisonMode ? 'TUNNEL 疊加回放' : interactive ? '互動 3D 進壘回放' : resultProgress > 0.65 ? `挑戰判定 · ${verdict}` : '進壘挑戰回放'}</Text>
          <Text style={styles.hudValue}>
            {pitchTypeLabel(type)}{speedKmh != null ? ` · ${formatSpeed(speedKmh, settings.speedUnit)} ${speedUnitLabel(settings.speedUnit)}` : ''}
          </Text>
        </View>
        {model.isEstimated ? (
          <View style={styles.estimatedBadge}>
            <Text style={styles.estimatedText}>部分估算</Text>
          </View>
        ) : null}
      </View>

      <GestureDetector gesture={trajectoryCamera.gesture}>
      <View
        style={styles.stage}
        collapsable={false}
        onLayout={(event) => trajectoryCamera.setViewportSize(event.nativeEvent.layout.width, event.nativeEvent.layout.height)}
      >
      <Image
        source={STADIUM_BACKGROUND}
        style={styles.stadiumBackground}
        resizeMode="cover"
        blurRadius={6}
      />
      <View pointerEvents="none" style={styles.stadiumShade} />
      <Svg width="100%" height="100%" viewBox={`0 0 ${VIEW_W} ${CHALLENGE_H}`}>
        <Defs>
          <LinearGradient id="zoneGradient" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#ffffff" stopOpacity="0.82" />
            <Stop offset="1" stopColor="#e2e8f0" stopOpacity="0.52" />
          </LinearGradient>
          <RadialGradient id="ballFill" cx="35%" cy="28%" rx="70%" ry="70%">
            <Stop offset="0" stopColor="#ffffff" />
            <Stop offset="0.72" stopColor="#f8fafc" />
            <Stop offset="1" stopColor="#cbd5e1" />
          </RadialGradient>
          <RadialGradient id="stageVignette" cx="50%" cy="46%" rx="72%" ry="70%">
            <Stop offset="0.52" stopColor="#020617" stopOpacity="0" />
            <Stop offset="1" stopColor="#020617" stopOpacity="0.48" />
          </RadialGradient>
        </Defs>
        <Rect x={0} y={0} width={VIEW_W} height={CHALLENGE_H} fill="url(#stageVignette)" />
        <TrajectorySceneStatic scene={projection.scene} challenge />
        {comparisonMode ? comparisonModels.map((comparisonModel, index) => (
          <TunnelTrajectory
            key={index}
            model={comparisonModel}
            camera={camera}
            progress={ballProgress}
            color={pitchDotColor(index + 1)}
          />
        )) : showPrevious && previousModel && previousProjection.path ? (
          <Path d={previousProjection.path} stroke={previousColor} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" fill="none" opacity={0.28} />
        ) : null}
        <TrajectorySceneDynamic
          pitchColor={comparisonMode ? pitchDotColor(0) : CHALLENGE_TRAIL}
          progress={ballProgress}
          timeline={projection.timeline}
          projected={projection.projected}
          shadowProjected={projection.shadowProjected}
          landingProjected={projection.landingProjected}
          landingShadow={projection.landingShadow}
          isStrike={model.isStrike}
          showLandingResult={comparisonMode}
          showPath={interactive || cameraRotationProgress < 1}
          challenge
        />

        {!comparisonMode && ballProgress >= 1 && landing ? (
          <G>
            <Circle cx={landing.x + 3} cy={landing.y + 5} r={ballRadius + 2} fill="#020617" opacity={0.24} />
            <Circle cx={landing.x} cy={landing.y} r={ballRadius} fill="url(#ballFill)" stroke="#e2e8f0" strokeWidth={1.2} />
            <Path
              d={`M ${landing.x - ballRadius * 0.42} ${landing.y - ballRadius * 0.82} C ${landing.x - ballRadius * 0.12} ${landing.y - ballRadius * 0.36}, ${landing.x - ballRadius * 0.12} ${landing.y + ballRadius * 0.36}, ${landing.x - ballRadius * 0.42} ${landing.y + ballRadius * 0.82}`}
              fill="none"
              stroke="#dc2626"
              strokeWidth={1.2 + resultProgress * 1.4}
              opacity={resultProgress}
            />
            <Path
              d={`M ${landing.x + ballRadius * 0.42} ${landing.y - ballRadius * 0.82} C ${landing.x + ballRadius * 0.12} ${landing.y - ballRadius * 0.36}, ${landing.x + ballRadius * 0.12} ${landing.y + ballRadius * 0.36}, ${landing.x + ballRadius * 0.42} ${landing.y + ballRadius * 0.82}`}
              fill="none"
              stroke="#dc2626"
              strokeWidth={1.2 + resultProgress * 1.4}
              opacity={resultProgress}
            />
            {BASEBALL_STITCHES.map((offset) => {
              const seamX = ballRadius * (0.14 + Math.abs(offset) * 0.33);
              const stitchY = landing.y + ballRadius * offset;
              const stitchHalf = ballRadius * 0.075;
              return (
                <G key={offset} opacity={resultProgress}>
                  <Line
                    x1={landing.x - seamX - stitchHalf}
                    y1={stitchY - stitchHalf * 0.7}
                    x2={landing.x - seamX + stitchHalf}
                    y2={stitchY + stitchHalf * 0.7}
                    stroke="#dc2626"
                    strokeWidth={1.1 + resultProgress * 0.7}
                    strokeLinecap="round"
                  />
                  <Line
                    x1={landing.x + seamX - stitchHalf}
                    y1={stitchY + stitchHalf * 0.7}
                    x2={landing.x + seamX + stitchHalf}
                    y2={stitchY - stitchHalf * 0.7}
                    stroke="#dc2626"
                    strokeWidth={1.1 + resultProgress * 0.7}
                    strokeLinecap="round"
                  />
                </G>
              );
            })}
            <Circle cx={landing.x - ballRadius * 0.28} cy={landing.y - ballRadius * 0.34} r={ballRadius * 0.13} fill="#fff" opacity={0.72} />
          </G>
        ) : null}

        {!comparisonMode && resultOpacity > 0 && landing && edgeProjected && edge && !edge.inside ? (
          <G opacity={resultOpacity}>
            <Line x1={measureStartX} y1={measureStartY} x2={edgeProjected.x} y2={edgeProjected.y} stroke="#020617" strokeWidth={5} opacity={0.72} />
            <Line x1={measureStartX} y1={measureStartY} x2={edgeProjected.x} y2={edgeProjected.y} stroke="#fff" strokeWidth={2.2} />
            <Polygon points={arrowHead(measureStartX, measureStartY, -measureUx, -measureUy)} fill="#fff" stroke="#020617" strokeWidth={1.2} />
            <Polygon points={arrowHead(edgeProjected.x, edgeProjected.y, measureUx, measureUy)} fill="#fff" stroke="#020617" strokeWidth={1.2} />
            <SvgText
              x={measureLabelX}
              y={measureLabelY}
              fill="#fff"
              stroke="#020617"
              strokeWidth={4}
              fontSize={16}
              fontWeight="900"
              textAnchor="middle"
            >
              {`${(edge.clearanceCm / 2.54).toFixed(1)}\"`}
            </SvgText>
            <SvgText
              x={measureLabelX}
              y={measureLabelY}
              fill="#fff"
              fontSize={16}
              fontWeight="900"
              textAnchor="middle"
            >
              {`${(edge.clearanceCm / 2.54).toFixed(1)}\"`}
            </SvgText>
          </G>
        ) : null}
      </Svg>
      </View>
      </GestureDetector>

      {interactive ? (
        <View style={styles.interactionRow}>
          <Text style={styles.interactionHint}>觸碰即暫停 · 單指旋轉 · 雙指縮放 · 雙擊重設</Text>
          <TouchableOpacity style={styles.resetButton} onPress={trajectoryCamera.resetView} accessibilityRole="button" accessibilityLabel="重設 3D 視角">
            <Text style={styles.resetText}>重設視角</Text>
          </TouchableOpacity>
        </View>
      ) : null}

      {interactive ? (
        <Pressable
          style={styles.timelineHitArea}
          onLayout={(event) => { timelineWidthRef.current = event.nativeEvent.layout.width; }}
          onPress={(event) => clock.seek(event.nativeEvent.locationX / timelineWidthRef.current)}
          onTouchMove={(event) => clock.seek(event.nativeEvent.locationX / timelineWidthRef.current)}
          accessibilityRole="adjustable"
          accessibilityLabel="3D 進壘回放位置"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(clock.progress * 100) }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(event) => clock.seek(clock.progress + (event.nativeEvent.actionName === 'increment' ? 0.1 : -0.1))}
        >
          <View style={styles.timelineTrack}>
            <View style={[styles.timelineFill, { width: `${clock.progress * 100}%` }]} />
            <View style={[styles.timelineThumb, { left: `${clock.progress * 100}%` }]} />
          </View>
        </Pressable>
      ) : null}

      <View style={styles.controls}>
        <TouchableOpacity style={styles.primaryButton} onPress={() => { trajectoryCamera.stopInertia(); clock.toggle(); }} accessibilityRole="button">
          <Text style={styles.primaryText}>{clock.progress >= 1 ? '重新播放' : clock.playing ? '暫停' : '播放'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.button} onPress={() => { trajectoryCamera.stopInertia(); clock.replay(); }} accessibilityRole="button">
          <Text style={styles.buttonText}>從頭播放</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.button}
          onPress={() => clock.setRate(clock.rate === 0.25 ? 0.5 : clock.rate === 0.5 ? 1 : 0.25)}
          accessibilityRole="button"
          accessibilityLabel={`目前播放速度 ${clock.rate} 倍`}
        >
          <Text style={styles.buttonText}>{clock.rate}×</Text>
        </TouchableOpacity>
      </View>

      {previousModel && !comparisonMode ? (
        <TouchableOpacity
          style={styles.compareRow}
          onPress={() => setShowPrevious((value) => !value)}
          accessibilityRole="switch"
          accessibilityState={{ checked: showPrevious }}
        >
          <View style={[styles.swatch, { backgroundColor: previousColor }]} />
          <Text style={styles.compareText}>球路配對疊加</Text>
          <Text style={styles.compareState}>{showPrevious ? '已顯示' : '已隱藏'}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: '100%', backgroundColor: Colors.panel, borderRadius: Radius.xl, overflow: 'hidden' },
  stage: { width: '100%', aspectRatio: VIEW_W / CHALLENGE_H, overflow: 'hidden' },
  stadiumBackground: { ...StyleSheet.absoluteFillObject, bottom: -258, width: undefined, height: undefined },
  stadiumShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(2,6,23,0.28)' },
  hud: { minHeight: 58, paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  hudLabel: { color: '#f9a8d4', fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  hudValue: { color: Colors.textInverse, fontSize: 15, fontWeight: '800', marginTop: 3 },
  estimatedBadge: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 99, backgroundColor: 'rgba(245,158,11,0.14)', borderWidth: 1, borderColor: '#f59e0b' },
  estimatedText: { color: '#fbbf24', fontSize: 10, fontWeight: '800' },
  controls: { flexDirection: 'row', gap: Spacing.sm, padding: Spacing.md },
  interactionRow: { minHeight: 44, paddingHorizontal: Spacing.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: Spacing.sm },
  interactionHint: { flex: 1, color: '#7dd3fc', fontSize: 10, fontWeight: '700' },
  resetButton: { minWidth: 72, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  resetText: { color: '#f9a8d4', fontSize: 11, fontWeight: '800' },
  timelineHitArea: { minHeight: 44, marginHorizontal: Spacing.md, justifyContent: 'center' },
  timelineTrack: { height: 5, borderRadius: 3, backgroundColor: '#334155' },
  timelineFill: { height: 5, borderRadius: 3, backgroundColor: CHALLENGE_TRAIL },
  timelineThumb: { position: 'absolute', top: -6, width: 17, height: 17, marginLeft: -8.5, borderRadius: 9, backgroundColor: '#fff', borderWidth: 3, borderColor: CHALLENGE_TRAIL },
  primaryButton: { flex: 1.2, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.lg, backgroundColor: CHALLENGE_TRAIL },
  primaryText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  button: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.lg, borderWidth: 1, borderColor: '#334155' },
  buttonText: { color: '#cbd5e1', fontSize: 13, fontWeight: '700' },
  compareRow: { minHeight: 44, marginHorizontal: Spacing.md, marginBottom: Spacing.md, paddingHorizontal: Spacing.md, borderRadius: Radius.lg, borderWidth: 1, borderColor: '#334155', flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  compareText: { color: '#e2e8f0', fontSize: 12, fontWeight: '700', flex: 1 },
  compareState: { color: '#94a3b8', fontSize: 11, fontWeight: '700' },
});
