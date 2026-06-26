import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import { useIsFocused } from '@react-navigation/native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Colors, Radius, Spacing } from '../theme';
import { useTrajectoryCamera } from '../hooks/useTrajectoryCamera';
import { useTrajectoryProjection } from '../hooks/useTrajectoryProjection';
import { Trajectory3DModel } from '../utils/trajectory3d';
import { VIEW_H, VIEW_PRESETS, VIEW_W } from '../utils/trajectoryProjection';
import TrajectorySceneDynamic from './trajectory/TrajectorySceneDynamic';
import TrajectorySceneStatic from './trajectory/TrajectorySceneStatic';

const MIN_ANIM_MS = 700;
const MAX_ANIM_MS = 2800;
const DEFAULT_ANIM_MS = 1450;

interface Props {
  model: Trajectory3DModel;
  pitchColor?: string;
  onGestureActiveChange?: (active: boolean) => void;
}

function animDurationMs(model: Trajectory3DModel) {
  if (model.durationS != null && model.durationS > 0) {
    return Math.round(Math.min(MAX_ANIM_MS, Math.max(MIN_ANIM_MS, model.durationS * 1000)));
  }
  return DEFAULT_ANIM_MS;
}

export default function Trajectory3DView({
  model,
  pitchColor = Colors.accent,
  onGestureActiveChange,
}: Props) {
  const isFocused = useIsFocused();
  const [playing, setPlaying] = useState(true);
  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef(Date.now());
  const pausedAtRef = useRef(0);
  const animMs = animDurationMs(model);

  const {
    camera,
    gesturing,
    activePreset,
    gesture,
    applyPreset,
    adjustZoom,
    resetView,
  } = useTrajectoryCamera({ onGestureActiveChange });

  const {
    scene,
    path,
    shadowPath,
    actualPath,
    trajectorySegments,
    projected,
    shadowProjected,
    landingProjected,
    landingShadow,
  } = useTrajectoryProjection(model, camera);

  useEffect(() => {
    if (!playing || !isFocused || gesturing) return;
    let cancelled = false;
    startedAtRef.current = Date.now() - pausedAtRef.current;

    const tick = () => {
      if (cancelled) return;
      const elapsed = Date.now() - startedAtRef.current;
      const next = Math.min(1, elapsed / animMs);
      setProgress(next);
      pausedAtRef.current = elapsed;
      if (next < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setPlaying(false);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [playing, isFocused, gesturing, animMs]);

  const toggle = () => {
    if (progress >= 1) {
      pausedAtRef.current = 0;
      setProgress(0);
      setPlaying(true);
      return;
    }
    setPlaying((value) => !value);
  };

  const replay = () => {
    pausedAtRef.current = 0;
    setProgress(0);
    setPlaying(true);
  };

  return (
    <View style={styles.wrap}>
      <GestureDetector gesture={gesture}>
        <View style={styles.gestureArea} collapsable={false}>
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

            <TrajectorySceneDynamic
              pitchColor={pitchColor}
              progress={progress}
              path={path}
              shadowPath={shadowPath}
              actualPath={actualPath}
              trajectorySegments={trajectorySegments}
              projected={projected}
              shadowProjected={shadowProjected}
              landingProjected={landingProjected}
              landingShadow={landingShadow}
              isStrike={model.isStrike}
            />
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

      <View style={styles.controls}>
        <TouchableOpacity style={styles.primaryBtn} onPress={toggle} accessibilityRole="button">
          <Text style={styles.primaryBtnText}>{progress >= 1 ? '重新播放' : playing ? '暫停' : '播放'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondaryBtn} onPress={replay} accessibilityRole="button">
          <Text style={styles.secondaryBtnText}>從頭播放</Text>
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
        <Text style={styles.legendText}>實線：高信心軌跡</Text>
        <Text style={styles.legendText}>虛線：低信心/補點</Text>
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
    minHeight: 38,
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
});
