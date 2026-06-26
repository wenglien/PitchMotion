import { useMemo } from 'react';
import { Trajectory3DModel } from '../utils/trajectory3d';
import {
  Camera,
  buildCameraBasis,
  buildStaticWorldScene,
  buildTrajectorySegments,
  ground,
  pathFrom,
  projectPoints,
  projectStaticScene,
  projectWorld,
} from '../utils/trajectoryProjection';

export function useTrajectoryProjection(model: Trajectory3DModel, camera: Camera) {
  const distanceM = model.distanceM;
  const curvePoints = model.smoothPoints?.length ? model.smoothPoints : model.points;

  const staticWorld = useMemo(
    () => buildStaticWorldScene(distanceM, model.strikeZone),
    [distanceM, model.strikeZone],
  );

  const groundCurvePoints = useMemo(
    () => curvePoints.map((point) => {
      const g = ground(point.x, point.z);
      return { ...point, x: g.x, y: g.y, z: g.z };
    }),
    [curvePoints],
  );

  const cameraBasis = useMemo(() => buildCameraBasis(camera), [camera]);

  const scene = useMemo(
    () => projectStaticScene(staticWorld, distanceM, cameraBasis),
    [staticWorld, distanceM, cameraBasis],
  );

  const projected = useMemo(
    () => projectPoints(curvePoints, distanceM, cameraBasis),
    [curvePoints, distanceM, cameraBasis],
  );

  const shadowProjected = useMemo(
    () => projectPoints(groundCurvePoints, distanceM, cameraBasis),
    [groundCurvePoints, distanceM, cameraBasis],
  );

  const path = useMemo(() => pathFrom(projected), [projected]);
  const shadowPath = useMemo(() => pathFrom(shadowProjected), [shadowProjected]);

  const trajectorySegments = useMemo(
    () => buildTrajectorySegments(projected, curvePoints),
    [projected, curvePoints],
  );

  const actualPath = useMemo(
    () => pathFrom(projected.filter((_, index) => !curvePoints[index]?.is_synthetic)),
    [curvePoints, projected],
  );

  const landingProjected = useMemo(
    () => (model.landingPoint ? projectWorld(model.landingPoint, distanceM, cameraBasis) : null),
    [model.landingPoint, distanceM, cameraBasis],
  );

  const landingShadow = useMemo(
    () => (model.landingPoint
      ? projectWorld(ground(model.landingPoint.x, 0), distanceM, cameraBasis)
      : null),
    [model.landingPoint, distanceM, cameraBasis],
  );

  return {
    scene,
    path,
    shadowPath,
    actualPath,
    trajectorySegments,
    projected,
    shadowProjected,
    landingProjected,
    landingShadow,
  };
}
