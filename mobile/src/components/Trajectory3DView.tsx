import React, { useMemo, useRef } from 'react';
import { Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { useIsFocused } from '@react-navigation/native';
import Svg, { Circle, Defs, G, Line, LinearGradient, Path, Rect, Stop, Text as SvgText } from 'react-native-svg';
import { Colors, Radius, Spacing } from '../theme';
import { useTrajectoryCamera } from '../hooks/useTrajectoryCamera';
import { usePitchReplayClock } from '../hooks/usePitchReplayClock';
import { useTrajectoryProjection } from '../hooks/useTrajectoryProjection';
import { PITCH_REPLAY_SCALE, PitchReplayModel, buildChallengeCallout } from '../utils/pitchReplay';
import { VIEW_H, VIEW_PRESETS, VIEW_W, buildCameraBasis, projectWorld } from '../utils/trajectoryProjection';
import TrajectorySceneDynamic from './trajectory/TrajectorySceneDynamic';
import TrajectorySceneStatic from './trajectory/TrajectorySceneStatic';

interface Props {
  model: PitchReplayModel;
  pitchColor?: string;
  comparisonModel?: PitchReplayModel | null;
  comparisonColor?: string;
  comparisonLabel?: string;
  onGestureActiveChange?: (active: boolean) => void;
}

export default function Trajectory3DView({
  model,
  pitchColor = Colors.accent,
  comparisonModel = null,
  comparisonColor = Colors.accent2,
  comparisonLabel = '上一球',
  onGestureActiveChange,
}: Props) {
  const isFocused = useIsFocused();

  const {
    camera,
    gesturing,
    activePreset,
    gesture,
    applyPreset,
    adjustZoom,
    resetView,
    setViewportSize,
  } = useTrajectoryCamera({ onGestureActiveChange });
  const { playing, progress, rate, setRate, replay, toggle, seek } = usePitchReplayClock(
    model.durationS * PITCH_REPLAY_SCALE,
    isFocused && !gesturing,
  );
  const timelineWidthRef = useRef(VIEW_W);

  const {
    scene,
    timeline,
    projected,
    shadowProjected,
    landingProjected,
    landingShadow,
  } = useTrajectoryProjection(model, camera);
  const comparisonProjection = useTrajectoryProjection(comparisonModel ?? model, camera);
  const challengeCallout = useMemo(() => buildChallengeCallout(model), [model]);
  const challengeEdgeProjected = useMemo(
    () => challengeCallout
      ? projectWorld(challengeCallout.point, model.distanceM, buildCameraBasis(camera))
      : null,
    [camera, challengeCallout, model.distanceM],
  );
  const curvePoints = model.points;
  const releaseProjected = projected[0] ?? null;
  const apexIndex = curvePoints.reduce((best, point, index) => (
    !curvePoints[best] || point.y > curvePoints[best].y ? index : best
  ), 0);
  const apexProjected = projected[apexIndex] ?? null;

  return (
    <View style={styles.wrap}>
      <GestureDetector gesture={gesture}>
        <View
          style={styles.gestureArea}
          collapsable={false}
          onLayout={(event) => setViewportSize(event.nativeEvent.layout.width, event.nativeEvent.layout.height)}
        >
          <Svg width="100%" height={VIEW_H} viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}>
            <Defs>
              <LinearGradient id="trajectorySky" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor="#101a33" />
                <Stop offset="1" stopColor="#08101f" />
              </LinearGradient>
              <LinearGradient id="groundGradient" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor="#123047" stopOpacity="0.58" />
                <Stop offset="1" stopColor="#0f172a" stopOpacity="0.95" />
              </LinearGradient>
              <LinearGradient id="zoneGradient" x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0" stopColor="#38bdf8" stopOpacity="0.28" />
                <Stop offset="1" stopColor="#0ea5e9" stopOpacity="0.04" />
              </LinearGradient>
            </Defs>

            <Rect x={0} y={0} width={VIEW_W} height={VIEW_H} rx={22} fill="url(#trajectorySky)" />

            <TrajectorySceneStatic scene={scene} />

            {comparisonModel && comparisonProjection.path ? (
              <Path
                d={comparisonProjection.path}
                stroke={comparisonColor}
                strokeWidth={4}
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="none"
                opacity={0.78}
              />
            ) : null}

            <G opacity={0.9}>
              {releaseProjected ? (
                <>
                  <Circle cx={releaseProjected.x} cy={releaseProjected.y} r={4.5} fill={Colors.panel} stroke="#f8fafc" strokeWidth={2} />
                  <SvgText x={releaseProjected.x + 8} y={releaseProjected.y - 8} fill="#f8fafc" fontSize={9} fontWeight="800">出手</SvgText>
                </>
              ) : null}
              {apexProjected ? (
                <>
                  <Circle cx={apexProjected.x} cy={apexProjected.y} r={4} fill={Colors.panel} stroke="#fbbf24" strokeWidth={2} />
                  <SvgText x={apexProjected.x + 8} y={apexProjected.y - 7} fill="#fbbf24" fontSize={9} fontWeight="800">最高點</SvgText>
                </>
              ) : null}
              {landingProjected ? (
                <>
                  <Circle cx={landingProjected.x} cy={landingProjected.y} r={4} fill="none" stroke="#94a3b8" strokeWidth={1.5} />
                  <SvgText x={landingProjected.x + 8} y={landingProjected.y + 13} fill="#cbd5e1" fontSize={9} fontWeight="800">本壘板</SvgText>
                </>
              ) : null}
            </G>

            <TrajectorySceneDynamic
              pitchColor={pitchColor}
              progress={progress}
              timeline={timeline}
              projected={projected}
              shadowProjected={shadowProjected}
              landingProjected={landingProjected}
              landingShadow={landingShadow}
              isStrike={model.isStrike}
            />

            {progress >= 1 && landingProjected && challengeEdgeProjected && challengeCallout && !challengeCallout.inside ? (
              <G>
                <Line
                  x1={landingProjected.x}
                  y1={landingProjected.y}
                  x2={challengeEdgeProjected.x}
                  y2={challengeEdgeProjected.y}
                  stroke="#f8fafc"
                  strokeWidth={1.8}
                />
                <SvgText
                  x={(landingProjected.x + challengeEdgeProjected.x) / 2}
                  y={(landingProjected.y + challengeEdgeProjected.y) / 2 - 6}
                  fill="#f8fafc"
                  fontSize={10}
                  fontWeight="900"
                  textAnchor="middle"
                >
                  {`${(challengeCallout.clearanceCm / 2.54).toFixed(1)}"`}
                </SvgText>
              </G>
            ) : null}
          </Svg>
        </View>
      </GestureDetector>

      <View style={styles.presetRow}>
        {VIEW_PRESETS.map((preset) => (
          <TouchableOpacity
            key={preset.id}
            style={[styles.presetBtn, activePreset === preset.id && styles.presetBtnActive]}
            onPress={() => applyPreset(preset)}
            accessibilityRole="button"
            accessibilityLabel={`切換到${preset.label}視角`}
          >
            <Text style={[styles.presetText, activePreset === preset.id && styles.presetTextActive]}>
              {preset.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.timelineRow}>
        <Pressable
          style={styles.timelineHitArea}
          onLayout={(event) => { timelineWidthRef.current = event.nativeEvent.layout.width; }}
          onPress={(event) => seek(event.nativeEvent.locationX / timelineWidthRef.current)}
          onTouchMove={(event) => seek(event.nativeEvent.locationX / timelineWidthRef.current)}
          accessibilityRole="adjustable"
          accessibilityLabel="3D 軌跡播放位置"
          accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
          accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
          onAccessibilityAction={(event) => seek(progress + (event.nativeEvent.actionName === 'increment' ? 0.1 : -0.1))}
        >
          <View style={styles.timelineTrack}>
            <View style={[styles.timelineFill, { width: `${progress * 100}%` }]} />
            <View style={[styles.timelineThumb, { left: `${progress * 100}%` }]} />
          </View>
        </Pressable>
        <Text style={styles.timelineText}>{Math.round(progress * 100)}%</Text>
      </View>

      <View style={styles.controls}>
        <TouchableOpacity style={styles.primaryBtn} onPress={toggle} accessibilityRole="button">
          <Text style={styles.primaryBtnText}>{progress >= 1 ? '重新播放' : playing ? '暫停' : '播放'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={replay} accessibilityRole="button">
          <Text style={styles.secondaryBtnText}>從頭播放</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.secondaryBtn}
          onPress={() => setRate(rate === 0.25 ? 0.5 : rate === 0.5 ? 1 : 0.25)}
          accessibilityRole="button"
          accessibilityLabel={`目前播放速度 ${rate} 倍`}
        >
          <Text style={styles.secondaryBtnText}>{rate}×</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.controls}>
        <TouchableOpacity
          style={styles.zoomBtn}
          onPress={() => adjustZoom(-0.25)}
          accessibilityRole="button"
          accessibilityLabel="縮小"
        >
          <Text style={styles.zoomBtnText}>−</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.zoomBtn}
          onPress={() => adjustZoom(0.25)}
          accessibilityRole="button"
          accessibilityLabel="放大"
        >
          <Text style={styles.zoomBtnText}>＋</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={resetView} accessibilityRole="button">
          <Text style={styles.secondaryBtnText}>重設視角</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.legendRow}>
        <Text style={styles.legendHint}>
          單指旋轉 · 雙指縮放 · 雙擊重設 · {camera.zoom.toFixed(1)}x
        </Text>
      </View>
      <View style={styles.legendRow}>
        <View style={styles.legendItem}>
          <View style={[styles.legendSwatch, { backgroundColor: pitchColor }]} />
          <Text style={styles.legendText}>本球</Text>
        </View>
        {comparisonModel && (
          <View style={styles.legendItem}>
            <View style={[styles.legendSwatch, { backgroundColor: comparisonColor }]} />
            <Text style={styles.legendText}>{comparisonLabel}</Text>
          </View>
        )}
      </View>
      <View style={styles.legendRow}>
        <Text style={styles.legendText}>{model.isEstimated ? '部分估算 · 實線顯示' : '實測軌跡'}</Text>
        <Text style={styles.legendText}>
          {model.isStrike === true ? '好球' : model.isStrike === false ? '壞球' : '落點'}標記
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: Colors.panel,
    borderRadius: Radius.xxl,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#1e293b',
  },
  gestureArea: {
    width: '100%',
    height: VIEW_H,
  },
  presetRow: {
    flexDirection: 'row',
    gap: Spacing.xs,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    backgroundColor: Colors.panel,
  },
  presetBtn: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: '#334155',
    backgroundColor: 'rgba(255,255,255,0.04)',
  },
  presetBtnActive: {
    backgroundColor: Colors.accent,
    borderColor: Colors.accent,
  },
  presetText: {
    color: '#cbd5e1',
    fontSize: 13,
    fontWeight: '700',
  },
  presetTextActive: {
    color: '#fff',
  },
  controls: {
    flexDirection: 'row',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.panel,
  },
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.sm,
    backgroundColor: Colors.panel,
  },
  timelineHitArea: {
    flex: 1,
    minHeight: 44,
    justifyContent: 'center',
  },
  timelineTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: '#334155',
  },
  timelineFill: {
    height: 5,
    borderRadius: 3,
    backgroundColor: Colors.accent,
  },
  timelineThumb: {
    position: 'absolute',
    top: -6,
    width: 17,
    height: 17,
    marginLeft: -8.5,
    borderRadius: 9,
    backgroundColor: '#f8fafc',
    borderWidth: 3,
    borderColor: Colors.accent,
  },
  timelineText: {
    width: 38,
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'right',
  },
  primaryBtn: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.lg,
    backgroundColor: Colors.accent,
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },
  zoomBtn: {
    width: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: '#334155',
  },
  zoomBtnText: {
    color: '#e2e8f0',
    fontSize: 20,
    fontWeight: '800',
    lineHeight: 22,
  },
  secondaryBtn: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: '#334155',
  },
  secondaryBtnText: {
    color: '#cbd5e1',
    fontSize: 14,
    fontWeight: '700',
  },
  legendRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    flexWrap: 'wrap',
    gap: Spacing.md,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.panel,
  },
  legendHint: {
    color: '#7dd3fc',
    fontSize: 11,
    fontWeight: '700',
  },
  legendText: {
    color: '#94a3b8',
    fontSize: 11,
    fontWeight: '600',
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendSwatch: { width: 18, height: 3, borderRadius: 2 },
});
