import {
  type AbstractMesh,
  LinesMesh,
  Ray,
  Scene,
  Vector3,
} from '@babylonjs/core';
import type { AutoPatrolComponent, TransformComponent } from '../../editor/model/components';
import type { SceneCameraPose } from '../../editor/model/SceneDocument';
import {
  getAutoPatrolWaypointWorldPose,
  getSceneCameraPosition,
  interpolateAutoPatrolPose,
  resolveAutoPatrolComponent,
  type AutoPatrolRouteValidationIssue,
  validateAutoPatrolRoute,
} from '../../editor/model/autoPatrolInspection';
import type { Vector3Data } from '../../editor/model/math';

export type AutoPatrolGroundCheckMode = 'off' | 'auto' | 'required';

export type AutoPatrolRouteGeometryValidationOptions = {
  clearanceRadiusMeters?: number;
  endpointPaddingMeters?: number;
  groundCheck?: AutoPatrolGroundCheckMode;
  groundSampleSpacingMeters?: number;
  maximumGroundDropMeters?: number;
  maximumWalkableSlopeDegrees?: number;
  pathSampleSpacingMeters?: number;
  initialPose?: SceneCameraPose;
};

export type AutoPatrolRouteSegmentInspection = {
  reachable: boolean;
  reason: 'clear' | 'blocked' | 'missing-ground';
  blockingMeshName: string | null;
};

export type AutoPatrolRouteGeometryInput = {
  component: AutoPatrolComponent;
  transform: TransformComponent;
};

type AutoPatrolObstacleMetadata = Record<string, unknown> & {
  editorAutoPatrolMarker?: boolean;
  editorGroundGrid?: boolean;
  editorManualRoamSpawn?: boolean;
  editorShadowCatcher?: boolean;
  editorSkyboxSphere?: boolean;
  manualRoamAvatar?: boolean;
  manualRoamCollider?: boolean;
  manualRoamFallbackGround?: boolean;
};

const DEFAULT_CLEARANCE_RADIUS_METERS = 0.25;
const DEFAULT_ENDPOINT_PADDING_METERS = 0.05;
const DEFAULT_GROUND_SAMPLE_SPACING_METERS = 1;
const DEFAULT_MAXIMUM_GROUND_DROP_METERS = 3;
const DEFAULT_MAXIMUM_WALKABLE_SLOPE_DEGREES = 50;
const DEFAULT_PATH_SAMPLE_SPACING_METERS = 0.5;
const MAX_GROUND_SAMPLE_COUNT = 256;
const MAX_PATH_SAMPLE_COUNT = 512;
const MIN_SMOOTH_PATH_SAMPLE_COUNT = 8;
const MIN_SEGMENT_LENGTH_METERS = 1e-5;

/** 过滤路线标记、网格、天空盒等编辑辅助物，只保留可阻挡巡检的场景实体。 */
export function isAutoPatrolRouteObstacleMesh(mesh: AbstractMesh): boolean {
  if (
    mesh.isDisposed()
    || !mesh.isEnabled()
    || !mesh.isVisible
    || mesh.visibility <= 0
    || mesh.infiniteDistance
    || mesh.getTotalVertices() <= 0
    || mesh instanceof LinesMesh
  ) return false;

  const metadata = mesh.metadata as AutoPatrolObstacleMetadata | null | undefined;
  if (
    metadata?.editorAutoPatrolMarker
    || metadata?.editorGroundGrid
    || metadata?.editorManualRoamSpawn
    || metadata?.editorShadowCatcher
    || metadata?.editorSkyboxSphere
    || metadata?.manualRoamAvatar
    || metadata?.manualRoamCollider
    || metadata?.manualRoamFallbackGround
  ) return false;

  const name = mesh.name.toLowerCase();
  return !name.includes('skybox')
    && !name.includes('groundgrid')
    && !name.includes('gizmo')
    && !name.includes('frustum')
    && !name.includes('trajectory')
    && !name.includes('highlight');
}

/**
 * 检查相邻路线节点之间是否穿过实体，且在有地面的场景中是否跨越不可达缺口。
 * `groundCheck=auto` 仅在首尾都能探测到地面时启用连续地面检查，兼容旧的空场景路线。
 */
export function inspectAutoPatrolRouteSegment(
  scene: Scene,
  from: Vector3Data,
  to: Vector3Data,
  options: AutoPatrolRouteGeometryValidationOptions = {},
): AutoPatrolRouteSegmentInspection {
  const start = toVector3(from);
  const end = toVector3(to);
  const displacement = end.subtract(start);
  const segmentLength = displacement.length();
  if (!Number.isFinite(segmentLength) || segmentLength < MIN_SEGMENT_LENGTH_METERS) {
    return { reachable: false, reason: 'blocked', blockingMeshName: null };
  }

  const direction = displacement.scale(1 / segmentLength);
  const endpointPadding = clampFinite(
    options.endpointPaddingMeters,
    0,
    segmentLength * 0.25,
    DEFAULT_ENDPOINT_PADDING_METERS,
  );
  const rayLength = Math.max(0, segmentLength - endpointPadding * 2);
  const rayOrigin = start.add(direction.scale(endpointPadding));
  const clearanceRadius = clampFinite(
    options.clearanceRadiusMeters,
    0,
    2,
    DEFAULT_CLEARANCE_RADIUS_METERS,
  );
  const right = createHorizontalRight(direction);
  const offsets = [
    Vector3.Zero(),
    Vector3.Up().scale(0.15),
    Vector3.Down().scale(0.85),
    Vector3.Down().scale(1.35),
    right.scale(clearanceRadius),
    right.scale(-clearanceRadius),
  ];

  for (const offset of offsets) {
    const hit = scene.pickWithRay(
      new Ray(rayOrigin.add(offset), direction, rayLength),
      isAutoPatrolRouteObstacleMesh,
      false,
    );
    if (hit?.hit && hit.pickedMesh) {
      return {
        reachable: false,
        reason: 'blocked',
        blockingMeshName: hit.pickedMesh.name || null,
      };
    }
  }

  const groundCheck = options.groundCheck ?? 'auto';
  if (groundCheck !== 'off') {
    const groundResult = inspectContinuousGround(scene, start, end, segmentLength, groundCheck, options);
    if (!groundResult) {
      return { reachable: false, reason: 'missing-ground', blockingMeshName: null };
    }
  }

  return { reachable: true, reason: 'clear', blockingMeshName: null };
}

export function createAutoPatrolSegmentReachabilityChecker(
  scene: Scene,
  options: AutoPatrolRouteGeometryValidationOptions = {},
): (from: Vector3Data, to: Vector3Data) => boolean {
  return (from, to) => inspectAutoPatrolRouteSegment(scene, from, to, options).reachable;
}

export function validateAutoPatrolRouteGeometry(
  scene: Scene,
  route: AutoPatrolRouteGeometryInput,
  options: AutoPatrolRouteGeometryValidationOptions = {},
): AutoPatrolRouteValidationIssue[] {
  const issues = validateAutoPatrolRoute(route.component, route.transform);
  if (route.component.waypoints.length < 2 || issues.length > 0) return issues;

  const component = resolveAutoPatrolComponent(route.component);
  const poses = component.waypoints.map((waypoint) => (
    getAutoPatrolWaypointWorldPose(waypoint, route.transform)
  ));
  const initialPose = options.initialPose;
  if (initialPose && !inspectAutoPatrolMotionPath(
    scene,
    initialPose,
    poses[0],
    initialPose,
    poses[1],
    component.pathType,
    true,
    options,
  )) {
    issues.push({
      code: 'unreachable-segment',
      message: '当前位置到节点 1 的路径被阻挡或不可达。',
      waypointIndex: 0,
    });
  }

  for (let sourceIndex = 0; sourceIndex < poses.length - 1; sourceIndex += 1) {
    const targetIndex = sourceIndex + 1;
    const previousPose = sourceIndex > 0
      ? poses[sourceIndex - 1]
      : component.playbackMode === 'loop' ? poses[poses.length - 1] : poses[sourceIndex];
    const nextPose = targetIndex + 1 < poses.length
      ? poses[targetIndex + 1]
      : component.playbackMode === 'loop' ? poses[0] : poses[targetIndex];
    const shouldStopAtEndpoint = component.waypoints[sourceIndex].dwellSeconds > 0
      || component.waypoints[targetIndex].dwellSeconds > 0
      || (component.playbackMode === 'ping-pong'
        && (sourceIndex === 0 || targetIndex === poses.length - 1));
    if (!inspectAutoPatrolMotionPath(
      scene,
      poses[sourceIndex],
      poses[targetIndex],
      previousPose,
      nextPose,
      component.pathType,
      shouldStopAtEndpoint,
      options,
    )) {
      issues.push({
        code: 'unreachable-segment',
        message: `节点 ${sourceIndex + 1} 到节点 ${targetIndex + 1} 的路径被阻挡或不可达。`,
        waypointIndex: targetIndex,
        previousWaypointIndex: sourceIndex,
      });
    }
  }

  if (component.playbackMode === 'loop') {
    const sourceIndex = poses.length - 1;
    const targetIndex = 0;
    const shouldStopAtEndpoint = component.waypoints[sourceIndex].dwellSeconds > 0
      || component.waypoints[targetIndex].dwellSeconds > 0;
    if (!inspectAutoPatrolMotionPath(
      scene,
      poses[sourceIndex],
      poses[targetIndex],
      poses[Math.max(0, sourceIndex - 1)],
      poses[Math.min(poses.length - 1, 1)],
      component.pathType,
      shouldStopAtEndpoint,
      options,
    )) {
      issues.push({
        code: 'unreachable-segment',
        message: `节点 ${sourceIndex + 1} 到节点 1 的路径被阻挡或不可达。`,
        waypointIndex: 0,
        previousWaypointIndex: sourceIndex,
      });
    }
  }
  return issues;
}

export function getAutoPatrolRouteGeometryError(
  scene: Scene,
  route: AutoPatrolRouteGeometryInput,
  options: AutoPatrolRouteGeometryValidationOptions = {},
): string | null {
  return validateAutoPatrolRouteGeometry(scene, route, options)[0]?.message ?? null;
}

function inspectContinuousGround(
  scene: Scene,
  start: Vector3,
  end: Vector3,
  segmentLength: number,
  mode: Exclude<AutoPatrolGroundCheckMode, 'off'>,
  options: AutoPatrolRouteGeometryValidationOptions,
): boolean {
  const maximumGroundDrop = clampFinite(
    options.maximumGroundDropMeters,
    0.25,
    100,
    DEFAULT_MAXIMUM_GROUND_DROP_METERS,
  );
  const maximumSlopeDegrees = clampFinite(
    options.maximumWalkableSlopeDegrees,
    0,
    89,
    DEFAULT_MAXIMUM_WALKABLE_SLOPE_DEGREES,
  );
  const minimumNormalY = Math.cos(maximumSlopeDegrees * Math.PI / 180);
  const hasStartGround = hasWalkableGround(scene, start, maximumGroundDrop, minimumNormalY);
  const hasEndGround = hasWalkableGround(scene, end, maximumGroundDrop, minimumNormalY);
  if (mode === 'auto' && !hasStartGround && !hasEndGround) return true;
  if (!hasStartGround || !hasEndGround) return false;

  const spacing = clampFinite(
    options.groundSampleSpacingMeters,
    0.1,
    20,
    DEFAULT_GROUND_SAMPLE_SPACING_METERS,
  );
  const sampleCount = Math.min(MAX_GROUND_SAMPLE_COUNT, Math.max(1, Math.ceil(segmentLength / spacing)));
  for (let index = 1; index < sampleCount; index += 1) {
    const point = Vector3.Lerp(start, end, index / sampleCount);
    if (!hasWalkableGround(scene, point, maximumGroundDrop, minimumNormalY)) return false;
  }
  return true;
}

function inspectAutoPatrolMotionPath(
  scene: Scene,
  fromPose: SceneCameraPose,
  toPose: SceneCameraPose,
  previousPose: SceneCameraPose,
  nextPose: SceneCameraPose,
  pathType: AutoPatrolComponent['pathType'],
  shouldStopAtEndpoint: boolean,
  options: AutoPatrolRouteGeometryValidationOptions,
): boolean {
  const from = getSceneCameraPosition(fromPose);
  const to = getSceneCameraPosition(toPose);
  const distance = Vector3.Distance(toVector3(from), toVector3(to));
  if (distance < MIN_SEGMENT_LENGTH_METERS) return true;
  const spacing = clampFinite(
    options.pathSampleSpacingMeters,
    0.05,
    10,
    DEFAULT_PATH_SAMPLE_SPACING_METERS,
  );
  const sampleCount = Math.min(
    MAX_PATH_SAMPLE_COUNT,
    Math.max(pathType === 'smooth' ? MIN_SMOOTH_PATH_SAMPLE_COUNT : 1, Math.ceil(distance / spacing)),
  );
  let previousPoint = from;
  for (let index = 1; index <= sampleCount; index += 1) {
    const pose = interpolateAutoPatrolPose(
      fromPose,
      toPose,
      previousPose,
      nextPose,
      index / sampleCount,
      pathType,
      shouldStopAtEndpoint,
    );
    const point = getSceneCameraPosition(pose);
    if (Vector3.DistanceSquared(toVector3(previousPoint), toVector3(point)) >= MIN_SEGMENT_LENGTH_METERS ** 2) {
      if (!inspectAutoPatrolRouteSegment(scene, previousPoint, point, options).reachable) return false;
    }
    previousPoint = point;
  }
  return true;
}

function hasWalkableGround(
  scene: Scene,
  point: Vector3,
  maximumGroundDropMeters: number,
  minimumNormalY: number,
): boolean {
  const probeOffset = 0.25;
  const ray = new Ray(
    point.add(Vector3.Up().scale(probeOffset)),
    Vector3.Down(),
    maximumGroundDropMeters + probeOffset,
  );
  const hits = scene.multiPickWithRay(ray, isAutoPatrolRouteObstacleMesh) ?? [];
  return hits.some((hit) => {
    if (!hit.hit || !hit.pickedPoint) return false;
    const normal = hit.getNormal(true);
    return Boolean(normal && normal.y >= minimumNormalY);
  });
}

function createHorizontalRight(direction: Vector3): Vector3 {
  const right = Vector3.Cross(Vector3.Up(), direction);
  if (right.lengthSquared() < MIN_SEGMENT_LENGTH_METERS) return Vector3.Right();
  return right.normalize();
}

function toVector3(value: Vector3Data): Vector3 {
  return new Vector3(value.x, value.y, value.z);
}

function clampFinite(value: number | undefined, min: number, max: number, fallback: number): number {
  const resolved = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, resolved));
}
