import React, { memo } from 'react';
import { Circle, Ellipse, G, Path, Text as SvgText } from 'react-native-svg';
import {
  ScreenPoint,
  clamp,
  pathUntilProgress,
  sampleAtProgress,
} from '../../utils/trajectoryProjection';

interface Props {
  pitchColor: string;
  progress: number;
  timeline: Array<{ t: number }>;
  projected: ScreenPoint[];
  shadowProjected: ScreenPoint[];
  landingProjected: ScreenPoint | null;
  landingShadow: ScreenPoint | null;
  isStrike: boolean | null;
  showLandingResult?: boolean;
  showPath?: boolean;
  challenge?: boolean;
}

function TrajectorySceneDynamic({
  pitchColor,
  progress,
  timeline,
  projected,
  shadowProjected,
  landingProjected,
  landingShadow,
  isStrike,
  showLandingResult = true,
  showPath = true,
  challenge = false,
}: Props) {
  if (!projected.length) return null;
  const ball = sampleAtProgress(projected, timeline, progress);
  const ballShadow = sampleAtProgress(shadowProjected, timeline, progress);
  const path = pathUntilProgress(projected, timeline, progress);
  const shadowPath = pathUntilProgress(shadowProjected, timeline, progress);
  const ballRadius = clamp(1.75 + ball.scale * 1.5, 1.5, 4.5);
  const landed = progress >= 1;
  const strikeColor = isStrike === true ? '#22c55e' : isStrike === false ? '#ef4444' : '#94a3b8';
  const strikeLabel = isStrike === true ? '好球' : isStrike === false ? '壞球' : '落點';

  return (
    <>
      {!challenge ? <Path d={shadowPath} stroke="#020617" strokeWidth={9} opacity={0.26} fill="none" strokeLinecap="round" strokeLinejoin="round" /> : null}
      {showPath ? (
        <G>
          <Path d={path} stroke={pitchColor} strokeWidth={challenge ? 7 : 11} opacity={challenge ? 0.2 : 0.14} fill="none" strokeLinecap="round" strokeLinejoin="round" />
          <Path d={path} stroke={pitchColor} strokeWidth={challenge ? 4.5 : 4} opacity={challenge ? 1 : 0.9} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </G>
      ) : null}

      {!landed ? (
        <>
          <Ellipse cx={ballShadow.x} cy={ballShadow.y + 3} rx={ballRadius * 1.6} ry={ballRadius * 0.5} fill="#020617" opacity={0.34} />
          <Circle cx={ball.x} cy={ball.y} r={ballRadius + 1.5} fill={pitchColor} opacity={0.18} />
          <Circle cx={ball.x} cy={ball.y} r={ballRadius} fill="#f8fafc" stroke={pitchColor} strokeWidth={1.5} />
          <Circle cx={ball.x - ballRadius * 0.28} cy={ball.y - ballRadius * 0.28} r={ballRadius * 0.28} fill="#fff" opacity={0.72} />
        </>
      ) : showLandingResult && landingProjected ? (
        <G>
          {landingShadow ? <Ellipse cx={landingShadow.x} cy={landingShadow.y + 2} rx={5} ry={2} fill="#020617" opacity={0.4} /> : null}
          <Circle cx={landingProjected.x} cy={landingProjected.y} r={9} fill={strikeColor} opacity={0.22} />
          <Circle cx={landingProjected.x} cy={landingProjected.y} r={5} fill="#f8fafc" stroke={strikeColor} strokeWidth={2} />
          <SvgText x={landingProjected.x} y={landingProjected.y - 14} fill={strikeColor} fontSize={10} fontWeight="800" textAnchor="middle">
            {strikeLabel}
          </SvgText>
        </G>
      ) : null}
    </>
  );
}

export default memo(TrajectorySceneDynamic);
