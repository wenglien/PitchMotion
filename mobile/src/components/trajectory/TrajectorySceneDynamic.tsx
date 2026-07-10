import React, { memo } from 'react';
import { Circle, Ellipse, G, Line, Path, Text as SvgText } from 'react-native-svg';
import { ScreenPoint, clamp, pathFrom, sampleAtProgress } from '../../utils/trajectoryProjection';

interface TrajectorySegment {
  d: string;
  width: number;
  opacity: number;
  dashed: boolean;
}

interface Props {
  pitchColor: string;
  progress: number;
  path: string;
  shadowPath: string;
  actualPath: string;
  trajectorySegments: TrajectorySegment[];
  projected: ScreenPoint[];
  shadowProjected: ScreenPoint[];
  landingProjected: ScreenPoint | null;
  landingShadow: ScreenPoint | null;
  isStrike: boolean | null;
}

function TrajectorySceneDynamic({
  pitchColor,
  progress,
  path,
  shadowPath,
  actualPath,
  trajectorySegments,
  projected,
  shadowProjected,
  landingProjected,
  landingShadow,
  isStrike,
}: Props) {
  const ball = sampleAtProgress(projected, progress);
  const ballShadow = sampleAtProgress(shadowProjected, progress);
  const ballRadius = clamp(1.75 + ball.scale * 1.5, 1.5, 4.5);
  const landed = progress >= 1;
  const strikeColor = isStrike === true ? '#22c55e' : isStrike === false ? '#ef4444' : '#94a3b8';
  const strikeLabel = isStrike === true ? '好球' : isStrike === false ? '壞球' : '落點';

  return (
    <>
      {shadowPath ? (
        <Path
          d={shadowPath}
          stroke="#020617"
          strokeWidth={9}
          opacity={0.26}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}

      {path ? (
        <G>
          <Path
            d={path}
            stroke={pitchColor}
            strokeWidth={11}
            opacity={0.14}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {trajectorySegments.map((segment, index) => (
            <Path
              key={`segment-${index}`}
              d={segment.d}
              stroke={pitchColor}
              strokeWidth={segment.width}
              opacity={segment.opacity}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={segment.dashed ? '6 5' : undefined}
            />
          ))}
          {actualPath ? (
            <Path
              d={actualPath}
              stroke="#f8fafc"
              strokeWidth={1.2}
              opacity={0.6}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray="4 4"
            />
          ) : null}
        </G>
      ) : null}

      {!landed ? (
        <>
          <Ellipse
            cx={ballShadow.x}
            cy={ballShadow.y + 3}
            rx={ballRadius * 1.6}
            ry={ballRadius * 0.5}
            fill="#020617"
            opacity={0.34}
          />
          <Line
            x1={ballShadow.x}
            y1={ballShadow.y}
            x2={ball.x}
            y2={ball.y}
            stroke="#94a3b8"
            strokeWidth={1}
            strokeDasharray="4 5"
            opacity={0.32}
          />
          <Circle cx={ball.x} cy={ball.y} r={ballRadius + 1.5} fill={pitchColor} opacity={0.18} />
          <Circle cx={ball.x} cy={ball.y} r={ballRadius} fill="#f8fafc" stroke={pitchColor} strokeWidth={1.5} />
          <Circle
            cx={ball.x - ballRadius * 0.28}
            cy={ball.y - ballRadius * 0.28}
            r={ballRadius * 0.28}
            fill="#ffffff"
            opacity={0.72}
          />
        </>
      ) : null}

      {landed && landingProjected ? (
        <G>
          {landingShadow ? (
            <Ellipse
              cx={landingShadow.x}
              cy={landingShadow.y + 2}
              rx={5}
              ry={2}
              fill="#020617"
              opacity={0.4}
            />
          ) : null}
          <Circle cx={landingProjected.x} cy={landingProjected.y} r={9} fill={strikeColor} opacity={0.22} />
          <Circle
            cx={landingProjected.x}
            cy={landingProjected.y}
            r={5}
            fill="#f8fafc"
            stroke={strikeColor}
            strokeWidth={2}
          />
          <SvgText
            x={landingProjected.x}
            y={landingProjected.y - 14}
            fill={strikeColor}
            fontSize={10}
            fontWeight="800"
            textAnchor="middle"
          >
            {strikeLabel}
          </SvgText>
        </G>
      ) : null}
    </>
  );
}

export default memo(TrajectorySceneDynamic);
