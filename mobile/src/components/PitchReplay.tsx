import React, { useMemo, useState } from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
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
import { formatSpeed, pitchColor, pitchTypeLabel, speedUnitLabel } from '../utils/conversions';
import { buildChallengeCallout, buildPitchReplayModel } from '../utils/pitchReplay';
import {
  buildCameraBasis,
  CENTER_X,
  DEFAULT_CAMERA,
  lerpYaw,
  projectWorld,
  VIEW_W,
} from '../utils/trajectoryProjection';
import { usePitchReplayClock } from '../hooks/usePitchReplayClock';
import { useTrajectoryProjection } from '../hooks/useTrajectoryProjection';
import { useSettings } from '../context/SettingsContext';
import TrajectorySceneDynamic from './trajectory/TrajectorySceneDynamic';
import TrajectorySceneStatic from './trajectory/TrajectorySceneStatic';

const POST_FLIGHT_S = 1.1;
const CHALLENGE_TRAIL = '#ec4899';
const CHALLENGE_H = 378;
const HOME_PLATE_ANCHOR_Y = 360;
const FLIGHT_REPLAY_SCALE = 3;
const BASEBALL_STITCHES = [-0.58, -0.3, 0, 0.3, 0.58];
const STADIUM_BACKGROUND = require('../../assets/replay/mound-to-home-plate.jpg');

interface Props {
  pitch: PitchResult;
  previousPitch?: PitchResult | null;
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

export default function PitchReplay({ pitch, previousPitch = null }: Props) {
  const isFocused = useIsFocused();
  const { settings } = useSettings();
  const [showPrevious, setShowPrevious] = useState(false);
  const model = useMemo(() => buildPitchReplayModel(pitch), [pitch]);
  const previousModel = useMemo(
    () => previousPitch ? buildPitchReplayModel(previousPitch) : null,
    [previousPitch],
  );
  const flightDurationS = model.durationS * FLIGHT_REPLAY_SCALE;
  const totalDurationS = flightDurationS + POST_FLIGHT_S;
  const clock = usePitchReplayClock(totalDurationS, isFocused);
  const flightFraction = flightDurationS / totalDurationS;
  const ballProgress = clamp01(clock.progress / flightFraction);
  const resultProgress = smooth((clock.progress - flightFraction) / (1 - flightFraction));
  const edge = useMemo(() => buildChallengeCallout(model), [model]);

  const camera = useMemo(() => {
    const pitcherTurn = smooth((ballProgress - 0.58) / 0.42);
    const orbitT = clamp01((ballProgress - 0.38) / 0.48);
    const orbit = Math.sin(Math.PI * orbitT) * (1 - pitcherTurn);
    const base = {
      ...DEFAULT_CAMERA,
      yaw: lerpYaw(-55 * orbit, 180, pitcherTurn),
      pitch: 5 + orbit * 5 - resultProgress * 2,
      zoom: 2.05 + ballProgress * 0.2 + resultProgress * 7.75,
      panX: 0,
      panY: 0,
    };
    const projectedPlate = projectWorld({ x: 0, y: 0, z: 0 }, model.distanceM, buildCameraBasis(base));
    return {
      ...base,
      panX: (CENTER_X - projectedPlate.x) * pitcherTurn,
      panY: (HOME_PLATE_ANCHOR_Y - projectedPlate.y) * pitcherTurn,
    };
  }, [ballProgress, model, resultProgress]);

  const projection = useTrajectoryProjection(model, camera);
  const previousProjection = useTrajectoryProjection(previousModel ?? model, camera);
  const edgeProjected = useMemo(
    () => edge ? projectWorld(edge.point, model.distanceM, buildCameraBasis(camera)) : null,
    [camera, edge, model.distanceM],
  );
  const type = pitch.speed_info?.pitch_type;
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
  const measureStartOffset = Math.min(ballRadius * 0.92, measureLength * 0.42);
  const measureStartX = (landing?.x ?? 0) + measureUx * measureStartOffset;
  const measureStartY = (landing?.y ?? 0) + measureUy * measureStartOffset;
  const measureLabelX = (measureStartX + (edgeProjected?.x ?? 0)) / 2 - measureUy * 20;
  const measureLabelY = (measureStartY + (edgeProjected?.y ?? 0)) / 2 + measureUx * 20 + 4;
  return (
    <View style={styles.wrap}>
      <View style={styles.hud}>
        <View>
          <Text style={styles.hudLabel}>{resultProgress > 0.65 ? `挑戰判定 · ${verdict}` : '進壘挑戰回放'}</Text>
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

      <View style={styles.stage}>
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
        {showPrevious && previousModel && previousProjection.path ? (
          <Path d={previousProjection.path} stroke={previousColor} strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" fill="none" opacity={0.28} />
        ) : null}
        <TrajectorySceneDynamic
          pitchColor={CHALLENGE_TRAIL}
          progress={ballProgress}
          timeline={projection.timeline}
          projected={projection.projected}
          shadowProjected={projection.shadowProjected}
          landingProjected={projection.landingProjected}
          landingShadow={projection.landingShadow}
          isStrike={model.isStrike}
          showLandingResult={false}
          challenge
        />

        {resultProgress > 0 && landing ? (
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

        {resultOpacity > 0 && landing && edgeProjected && edge ? (
          <G opacity={resultOpacity}>
            <Line x1={measureStartX} y1={measureStartY} x2={edgeProjected.x} y2={edgeProjected.y} stroke="#fff" strokeWidth={2.2} />
            <Polygon points={arrowHead(measureStartX, measureStartY, -measureUx, -measureUy)} fill="#fff" />
            <Polygon points={arrowHead(edgeProjected.x, edgeProjected.y, measureUx, measureUy)} fill="#fff" />
            <SvgText
              x={measureLabelX + 1}
              y={measureLabelY + 1}
              fill="#020617"
              fontSize={14}
              fontWeight="900"
              textAnchor="middle"
            >
              {`${(edge.clearanceCm / 2.54).toFixed(1)}\"`}
            </SvgText>
            <SvgText
              x={measureLabelX}
              y={measureLabelY}
              fill="#fff"
              fontSize={14}
              fontWeight="900"
              textAnchor="middle"
            >
              {`${(edge.clearanceCm / 2.54).toFixed(1)}\"`}
            </SvgText>
          </G>
        ) : null}
      </Svg>
      </View>

      <View style={styles.controls}>
        <TouchableOpacity style={styles.primaryButton} onPress={clock.toggle} accessibilityRole="button">
          <Text style={styles.primaryText}>{clock.progress >= 1 ? '重新播放' : clock.playing ? '暫停' : '播放'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.button} onPress={clock.replay} accessibilityRole="button">
          <Text style={styles.buttonText}>從頭播放</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.button}
          onPress={() => clock.setRate(clock.rate === 0.5 ? 1 : 0.5)}
          accessibilityRole="button"
          accessibilityLabel={`目前播放速度 ${clock.rate} 倍`}
        >
          <Text style={styles.buttonText}>{clock.rate}×</Text>
        </TouchableOpacity>
      </View>

      {previousModel ? (
        <TouchableOpacity
          style={styles.compareRow}
          onPress={() => setShowPrevious((value) => !value)}
          accessibilityRole="switch"
          accessibilityState={{ checked: showPrevious }}
        >
          <View style={[styles.swatch, { backgroundColor: previousColor }]} />
          <Text style={styles.compareText}>比較上一球</Text>
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
  primaryButton: { flex: 1.2, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.lg, backgroundColor: CHALLENGE_TRAIL },
  primaryText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  button: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.lg, borderWidth: 1, borderColor: '#334155' },
  buttonText: { color: '#cbd5e1', fontSize: 13, fontWeight: '700' },
  compareRow: { minHeight: 44, marginHorizontal: Spacing.md, marginBottom: Spacing.md, paddingHorizontal: Spacing.md, borderRadius: Radius.lg, borderWidth: 1, borderColor: '#334155', flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  swatch: { width: 10, height: 10, borderRadius: 5 },
  compareText: { color: '#e2e8f0', fontSize: 12, fontWeight: '700', flex: 1 },
  compareState: { color: '#94a3b8', fontSize: 11, fontWeight: '700' },
});
