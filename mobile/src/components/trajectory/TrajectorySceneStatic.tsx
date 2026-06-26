import React, { memo } from 'react';
import { Circle, Ellipse, G, Line, Polygon, Text as SvgText } from 'react-native-svg';
import { polygonPoints } from '../../utils/trajectoryProjection';

type ProjectedScene = ReturnType<typeof import('../../utils/trajectoryProjection').projectStaticScene>;

interface Props {
  scene: ProjectedScene;
}

function TrajectorySceneStatic({ scene }: Props) {
  return (
    <>
      <Polygon
        points={polygonPoints(scene.lane)}
        fill="url(#groundGradient)"
        stroke="#1e3a5f"
        strokeWidth={1.2}
      />

      <Line
        x1={scene.laneNearLeft.x}
        y1={scene.laneNearLeft.y}
        x2={scene.laneFarLeft.x}
        y2={scene.laneFarLeft.y}
        stroke="#38bdf8"
        strokeWidth={1.2}
        opacity={0.24}
      />
      <Line
        x1={scene.laneNearRight.x}
        y1={scene.laneNearRight.y}
        x2={scene.laneFarRight.x}
        y2={scene.laneFarRight.y}
        stroke="#38bdf8"
        strokeWidth={1.2}
        opacity={0.24}
      />

      {scene.xGrid.map((line) => (
        <Line
          key={`xgrid-${line.x}`}
          x1={line.near.x}
          y1={line.near.y}
          x2={line.far.x}
          y2={line.far.y}
          stroke="#475569"
          strokeWidth={line.x === 0 ? 1.4 : 0.8}
          strokeDasharray={line.x === 0 ? '5 7' : undefined}
          opacity={line.x === 0 ? 0.5 : 0.24}
        />
      ))}

      {scene.zTicks.map((tick) => (
        <G key={`ztick-${tick.ratio}`}>
          <Line
            x1={tick.left.x}
            y1={tick.left.y}
            x2={tick.right.x}
            y2={tick.right.y}
            stroke="#64748b"
            strokeWidth={0.9}
            opacity={0.3}
          />
          <SvgText x={tick.right.x + 5} y={tick.right.y + 3} fill="#64748b" fontSize={8} fontWeight="700">
            {`${Math.round(tick.z)}m`}
          </SvgText>
        </G>
      ))}

      <Ellipse
        cx={scene.moundPt.x}
        cy={scene.moundPt.y + 4}
        rx={26 * scene.moundPt.scale}
        ry={10 * scene.moundPt.scale}
        fill="#475569"
        opacity={0.6}
      />
      <Circle cx={scene.moundPt.x} cy={scene.moundPt.y - 4} r={7 * scene.moundPt.scale} fill="#94a3b8" opacity={0.5} />
      <SvgText x={scene.moundPt.x} y={scene.moundPt.y - 18} fill="#94a3b8" fontSize={11} fontWeight="700" textAnchor="middle">
        投手端
      </SvgText>

      <Polygon
        points={polygonPoints(scene.homePlate)}
        fill="#e2e8f0"
        opacity={0.94}
        stroke="#f8fafc"
        strokeWidth={1}
      />
      <SvgText x={scene.platePt.x} y={scene.platePt.y + 22} fill="#cbd5e1" fontSize={11} fontWeight="700" textAnchor="middle">
        本壘板
      </SvgText>

      <Polygon
        points={polygonPoints(scene.strikeZone)}
        fill="url(#zoneGradient)"
        stroke="#38bdf8"
        strokeWidth={2}
        opacity={0.92}
      />
      {scene.zoneHLines.map((line, index) => (
        <Line
          key={`zone-h-${index}`}
          x1={line.left.x}
          y1={line.left.y}
          x2={line.right.x}
          y2={line.right.y}
          stroke="#7dd3fc"
          strokeWidth={1}
          opacity={0.36}
        />
      ))}
      {scene.zoneVLines.map((line, index) => (
        <Line
          key={`zone-v-${index}`}
          x1={line.bottom.x}
          y1={line.bottom.y}
          x2={line.top.x}
          y2={line.top.y}
          stroke="#7dd3fc"
          strokeWidth={1}
          opacity={0.36}
        />
      ))}
    </>
  );
}

export default memo(TrajectorySceneStatic);
