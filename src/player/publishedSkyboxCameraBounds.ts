import {
  type ArcRotateCamera,
  type Camera,
  type Observer,
  type Scene,
  Vector3,
} from '@babylonjs/core';
import { isEntityEffectivelyVisible } from '../editor/model/entityHierarchy';
import {
  getSceneSkyboxEntity,
  getSkyboxSphereDiameterMeters,
  SKYBOX_SPHERE_INNER_RADIUS_RATIO,
  type SceneDocument,
} from '../editor/model/SceneDocument';
import type { Vector3Data } from '../editor/model/math';

export type PublishedSkyboxCameraBounds = {
  center: Vector3Data;
  radiusMeters: number;
};

export type PublishedSkyboxCameraBoundsController = {
  constrain: () => void;
  dispose: () => void;
};

type CameraPoseSnapshot = {
  radius: number;
  target: Vector3;
};

const CAMERA_BOUNDARY_MIN_MARGIN_METERS = 0.01;
const CAMERA_BOUNDARY_RELATIVE_MARGIN = 1e-6;
const CAMERA_BOUNDARY_EPSILON = 1e-7;

function isFiniteVector(value: Vector3Data): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function getSafeSkyboxRadius(radiusMeters: number): number {
  const margin = Math.max(
    CAMERA_BOUNDARY_MIN_MARGIN_METERS,
    radiusMeters * CAMERA_BOUNDARY_RELATIVE_MARGIN,
  );
  return Math.max(0, radiusMeters * SKYBOX_SPHERE_INNER_RADIUS_RATIO - margin);
}

/** 计算从相机 target 沿当前观察方向射出球体时允许的最大轨道半径。 */
function resolveRaySphereExitDistance(
  target: Vector3,
  cameraPosition: Vector3,
  sphereCenter: Vector3,
  sphereRadius: number,
): number | null {
  const direction = cameraPosition.subtract(target);
  const directionLength = direction.length();
  if (!Number.isFinite(directionLength) || directionLength <= CAMERA_BOUNDARY_EPSILON) return null;
  direction.scaleInPlace(1 / directionLength);

  const targetOffset = target.subtract(sphereCenter);
  const projection = Vector3.Dot(targetOffset, direction);
  const discriminant = projection * projection
    + sphereRadius * sphereRadius
    - targetOffset.lengthSquared();
  if (!Number.isFinite(discriminant) || discriminant < 0) return null;

  const exitDistance = -projection + Math.sqrt(Math.max(0, discriminant));
  return Number.isFinite(exitDistance) && exitDistance >= 0 ? exitDistance : null;
}

function clampPointToSphere(point: Vector3, center: Vector3, radius: number): Vector3 {
  const offset = point.subtract(center);
  const distance = offset.length();
  if (!Number.isFinite(distance) || distance <= CAMERA_BOUNDARY_EPSILON) return center.clone();
  return center.add(offset.scale(radius / distance));
}

/**
 * 仅用于发布 Viewer：保持远裁剪距离不变，同时把所有相机入口限制在实际天空盒球体内。
 * 滚轮/旋转优先缩短轨道半径；纯平移则整体回退 target，避免命中边界时改变观察距离。
 */
export function createPublishedSkyboxCameraBoundsController(
  scene: Scene,
  camera: ArcRotateCamera,
  bounds: PublishedSkyboxCameraBounds,
): PublishedSkyboxCameraBoundsController {
  const center = new Vector3(bounds.center.x, bounds.center.y, bounds.center.z);
  const safeRadius = getSafeSkyboxRadius(bounds.radiusMeters);
  if (!isFiniteVector(bounds.center) || !Number.isFinite(safeRadius) || safeRadius <= 0) {
    return { constrain: () => undefined, dispose: () => undefined };
  }

  const originalUpperRadiusLimit = camera.upperRadiusLimit;
  let previousPose: CameraPoseSnapshot | null = null;
  let disposed = false;

  const syncUpperRadiusLimit = (): void => {
    camera.getViewMatrix(true);
    const exitDistance = resolveRaySphereExitDistance(camera.target, camera.position, center, safeRadius);
    const configuredLimit = originalUpperRadiusLimit ?? Number.POSITIVE_INFINITY;
    camera.upperRadiusLimit = exitDistance === null
      ? originalUpperRadiusLimit
      : Math.min(configuredLimit, exitDistance);
  };

  const constrainCamera = (): boolean => {
    if (disposed) return false;
    camera.getViewMatrix(true);

    const position = camera.position.clone();
    const target = camera.target.clone();
    if (!isFiniteVector(position) || !isFiniteVector(target) || !Number.isFinite(camera.radius)) return false;

    let corrected = false;
    const distanceFromCenter = Vector3.Distance(position, center);
    if (distanceFromCenter > safeRadius + CAMERA_BOUNDARY_EPSILON) {
      const targetMoved = previousPose !== null
        && !target.equalsWithEpsilon(previousPose.target, CAMERA_BOUNDARY_EPSILON);
      const radiusChanged = previousPose !== null
        && Math.abs(camera.radius - previousPose.radius) > CAMERA_BOUNDARY_EPSILON;
      const exitDistance = resolveRaySphereExitDistance(target, position, center, safeRadius);
      const minimumRadius = camera.lowerRadiusLimit ?? 0;
      const canClampRadius = exitDistance !== null
        && exitDistance >= minimumRadius
        && camera.radius > exitDistance
        && (previousPose === null || radiusChanged || !targetMoved);

      if (canClampRadius) {
        camera.radius = exitDistance;
        camera.inertialRadiusOffset = 0;
        camera.movement.resetZoomVelocity();
        corrected = true;
      } else {
        const constrainedPosition = clampPointToSphere(position, center, safeRadius);
        camera.target.addInPlace(constrainedPosition.subtract(position));
        camera.inertialPanningX = 0;
        camera.inertialPanningY = 0;
        camera.movement.resetPanVelocity();
        corrected = true;
      }

      camera.getViewMatrix(true);
      if (Vector3.Distance(camera.position, center) > safeRadius + CAMERA_BOUNDARY_EPSILON) {
        camera.setPosition(clampPointToSphere(camera.position, center, safeRadius));
        camera.movement.resetZoomVelocity();
        camera.movement.resetPanVelocity();
        camera.getViewMatrix(true);
      }
    }

    syncUpperRadiusLimit();
    previousPose = { radius: camera.radius, target: camera.target.clone() };
    return corrected;
  };

  const constrain = (): void => {
    constrainCamera();
  };
  constrainCamera();
  const afterCheckInputsObserver: Observer<Camera> = camera.onAfterCheckInputsObservable.add(constrain);
  const beforeCameraRenderObserver: Observer<Camera> = scene.onBeforeCameraRenderObservable.add((activeCamera) => {
    if (activeCamera === camera && constrainCamera()) scene.updateTransformMatrix(true);
  });

  return {
    constrain,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      camera.onAfterCheckInputsObservable.remove(afterCheckInputsObserver);
      scene.onBeforeCameraRenderObservable.remove(beforeCameraRenderObserver);
      camera.upperRadiusLimit = originalUpperRadiusLimit;
    },
  };
}

/** 仅在发布场景存在有效可见天空盒时安装相机边界。 */
export function createPublishedSkyboxCameraBoundsControllerForDocument(
  scene: Scene,
  camera: ArcRotateCamera,
  document: SceneDocument,
): PublishedSkyboxCameraBoundsController | null {
  const skyboxEntity = getSceneSkyboxEntity(document);
  if (!skyboxEntity || !isEntityEffectivelyVisible(document.entities, skyboxEntity)) return null;

  return createPublishedSkyboxCameraBoundsController(scene, camera, {
    center: skyboxEntity.components.transform.position,
    radiusMeters: getSkyboxSphereDiameterMeters(skyboxEntity.components.transform.scale) / 2,
  });
}
