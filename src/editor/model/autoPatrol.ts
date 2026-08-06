import type {
  AutoPatrolCameraPose,
  AutoPatrolComponent,
  AutoPatrolPathType,
  AutoPatrolPlaybackMode,
  AutoPatrolWaypoint,
  TransformComponent,
} from './components';
import type { SceneCameraPose } from './SceneDocument';
import type { Vector3Data } from './math';

export const AUTO_PATROL_MIN_WAYPOINTS = 2;
export const AUTO_PATROL_MAX_WAYPOINTS = 512;
export const AUTO_PATROL_DEFAULT_TRAVEL_SECONDS = 1;
export const AUTO_PATROL_DEFAULT_DWELL_SECONDS = 0;
export const AUTO_PATROL_MAX_DURATION_SECONDS = 24 * 60 * 60;
export const AUTO_PATROL_MIN_VIEW_DISTANCE = 0.01;
export const AUTO_PATROL_MAX_VIEW_DISTANCE = 100_000;

const CAMERA_BETA_EPSILON = 1e-4;
const VECTOR_EPSILON = 1e-9;
const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;

type QuaternionData = { x: number; y: number; z: number; w: number };

type AutoPatrolWaypointViewPatch = {
  position?: Vector3Data;
  headingDegrees?: number;
  pitchDegrees?: number;
  viewDistance?: number;
};

export type AutoPatrolWaypointView = {
  position: Vector3Data;
  headingDegrees: number;
  pitchDegrees: number;
  viewDistance: number;
};

/** 新建巡检路线采用平滑闭环，但不自动抢占相机。 */
export function createDefaultAutoPatrolComponent(): AutoPatrolComponent {
  return {
    enabled: true,
    autoStart: false,
    pathType: 'smooth',
    playbackMode: 'loop',
    waypoints: [],
  };
}

/** 根据相机世界位置和观察目标生成完整 ArcRotateCamera 位姿。 */
export function createSceneCameraPose(position: Vector3Data, target: Vector3Data): SceneCameraPose {
  const offset = subtractVector(position, target);
  const rawRadius = vectorLength(offset);
  const radius = clampFinite(rawRadius, AUTO_PATROL_MIN_VIEW_DISTANCE, AUTO_PATROL_MAX_VIEW_DISTANCE, 1);
  const normalized = rawRadius > VECTOR_EPSILON
    ? scaleVector(offset, 1 / rawRadius)
    : { x: 0, y: 0, z: -1 };

  return {
    alpha: normalizeRadians(Math.atan2(normalized.z, normalized.x)),
    beta: clampFinite(
      Math.acos(clampFinite(normalized.y, -1, 1, 0)),
      CAMERA_BETA_EPSILON,
      Math.PI - CAMERA_BETA_EPSILON,
      Math.PI / 2,
    ),
    radius,
    target: cloneVector(target),
  };
}

/** 将 ArcRotateCamera 位姿转换为实际相机世界/局部位置。 */
export function getSceneCameraPosition(pose: AutoPatrolCameraPose | SceneCameraPose): Vector3Data {
  const sinBeta = Math.sin(pose.beta);
  return {
    x: pose.target.x + pose.radius * Math.cos(pose.alpha) * sinBeta,
    y: pose.target.y + pose.radius * Math.cos(pose.beta),
    z: pose.target.z + pose.radius * Math.sin(pose.alpha) * sinBeta,
  };
}

/** 把当前世界视角转换为路线局部节点，供 F1 录制和“添加点位”共用。 */
export function createAutoPatrolWaypointFromWorldPose(
  worldPose: SceneCameraPose,
  routeTransform: TransformComponent,
  id = createWaypointId(),
): AutoPatrolWaypoint {
  return {
    id,
    pose: worldPoseToLocalPose(worldPose, routeTransform),
    travelDurationSeconds: AUTO_PATROL_DEFAULT_TRAVEL_SECONDS,
    dwellSeconds: AUTO_PATROL_DEFAULT_DWELL_SECONDS,
    arrivalActions: [],
  };
}

/** 将持久化的局部节点转换为可直接应用到场景相机的世界位姿。 */
export function getAutoPatrolWaypointWorldPose(
  waypoint: Pick<AutoPatrolWaypoint, 'pose'>,
  routeTransform: TransformComponent,
): SceneCameraPose {
  const localPosition = getSceneCameraPosition(waypoint.pose);
  const rotation = quaternionFromTransform(routeTransform);
  const worldPosition = addVector(rotateVector(localPosition, rotation), routeTransform.position);
  const worldTarget = addVector(rotateVector(waypoint.pose.target, rotation), routeTransform.position);
  return createSceneCameraPose(worldPosition, worldTarget);
}

/** 返回 Inspector 使用的世界位置、水平角、俯仰角和观察距离。 */
export function getAutoPatrolWaypointView(
  waypoint: Pick<AutoPatrolWaypoint, 'pose'>,
  routeTransform: TransformComponent,
): AutoPatrolWaypointView {
  const worldPose = getAutoPatrolWaypointWorldPose(waypoint, routeTransform);
  const position = getSceneCameraPosition(worldPose);
  const direction = normalizeVector(subtractVector(worldPose.target, position), { x: 0, y: 0, z: 1 });
  const headingDegrees = normalizeDegrees(Math.atan2(direction.x, direction.z) * RADIANS_TO_DEGREES);
  const pitchDegrees = Math.asin(clampFinite(direction.y, -1, 1, 0)) * RADIANS_TO_DEGREES;
  return {
    position,
    headingDegrees,
    pitchDegrees,
    viewDistance: worldPose.radius,
  };
}

/** 使用 Inspector 或节点 Gizmo 的世界参数更新节点，同时继续以路线局部坐标持久化。 */
export function updateAutoPatrolWaypointView(
  waypoint: AutoPatrolWaypoint,
  routeTransform: TransformComponent,
  patch: AutoPatrolWaypointViewPatch,
): AutoPatrolWaypoint {
  const current = getAutoPatrolWaypointView(waypoint, routeTransform);
  const position = sanitizeVector(patch.position ?? current.position, current.position);
  const headingDegrees = normalizeDegrees(finiteOrFallback(patch.headingDegrees, current.headingDegrees));
  const pitchDegrees = clampFinite(
    finiteOrFallback(patch.pitchDegrees, current.pitchDegrees),
    -89,
    89,
    current.pitchDegrees,
  );
  const viewDistance = clampFinite(
    finiteOrFallback(patch.viewDistance, current.viewDistance),
    AUTO_PATROL_MIN_VIEW_DISTANCE,
    AUTO_PATROL_MAX_VIEW_DISTANCE,
    current.viewDistance,
  );
  const heading = headingDegrees * DEGREES_TO_RADIANS;
  const pitch = pitchDegrees * DEGREES_TO_RADIANS;
  const cosPitch = Math.cos(pitch);
  const direction = {
    x: Math.sin(heading) * cosPitch,
    y: Math.sin(pitch),
    z: Math.cos(heading) * cosPitch,
  };
  const target = addVector(position, scaleVector(direction, viewDistance));
  return {
    ...waypoint,
    pose: worldPoseToLocalPose(createSceneCameraPose(position, target), routeTransform),
  };
}

/** 以不可变方式移动节点；空间位置不会参与排序。 */
export function moveAutoPatrolWaypoint(
  component: AutoPatrolComponent,
  waypointId: string,
  destinationIndex: number,
): AutoPatrolComponent {
  const sourceIndex = component.waypoints.findIndex((waypoint) => waypoint.id === waypointId);
  if (sourceIndex < 0 || component.waypoints.length <= 1) return cloneAutoPatrolComponent(component);
  const targetIndex = Math.max(0, Math.min(component.waypoints.length - 1, Math.trunc(destinationIndex)));
  if (sourceIndex === targetIndex) return cloneAutoPatrolComponent(component);
  const waypoints = component.waypoints.map(cloneWaypoint);
  const [moved] = waypoints.splice(sourceIndex, 1);
  waypoints.splice(targetIndex, 0, moved);
  return { ...component, waypoints };
}

/** 复制一个节点并插入源节点之后；新节点必须使用独立 ID，避免拾取和排序冲突。 */
export function duplicateAutoPatrolWaypoint(
  component: AutoPatrolComponent,
  waypointId: string,
  duplicateId = createWaypointId(),
): AutoPatrolComponent {
  const sourceIndex = component.waypoints.findIndex((waypoint) => waypoint.id === waypointId);
  if (
    sourceIndex < 0
    || component.waypoints.length >= AUTO_PATROL_MAX_WAYPOINTS
    || component.waypoints.some((waypoint) => waypoint.id === duplicateId)
  ) {
    return cloneAutoPatrolComponent(component);
  }

  const waypoints = component.waypoints.map(cloneWaypoint);
  const duplicate = cloneWaypoint({ ...waypoints[sourceIndex], id: duplicateId });
  waypoints.splice(sourceIndex + 1, 0, duplicate);
  return { ...component, waypoints };
}

/** 深拷贝路线配置；实体复制时可强制关闭唯一自动启动标记。 */
export function cloneAutoPatrolComponent(
  component: AutoPatrolComponent,
  options: { disableAutoStart?: boolean } = {},
): AutoPatrolComponent {
  return {
    enabled: component.enabled,
    autoStart: options.disableAutoStart ? false : component.autoStart,
    pathType: component.pathType,
    playbackMode: component.playbackMode,
    waypoints: component.waypoints.map(cloneWaypoint),
  };
}

/** 场景文件、Store 和外部输入共用的巡检组件边界校验。 */
export function sanitizeAutoPatrolComponent(value: unknown): AutoPatrolComponent | null {
  if (!isPlainObject(value)) return null;
  const pathType = sanitizePathType(value.pathType);
  const playbackMode = sanitizePlaybackMode(value.playbackMode);
  if (!pathType || !playbackMode || !Array.isArray(value.waypoints)) return null;
  if (value.waypoints.length > AUTO_PATROL_MAX_WAYPOINTS) return null;

  const waypoints: AutoPatrolWaypoint[] = [];
  const waypointIds = new Set<string>();
  for (const rawWaypoint of value.waypoints) {
    const waypoint = sanitizeWaypoint(rawWaypoint);
    if (!waypoint || waypointIds.has(waypoint.id)) return null;
    waypointIds.add(waypoint.id);
    waypoints.push(waypoint);
  }

  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    autoStart: typeof value.autoStart === 'boolean' ? value.autoStart : false,
    pathType,
    playbackMode,
    waypoints,
  };
}

/** 为编辑态路径线生成相机位置采样；闭环模式自动补回首点。 */
export function sampleAutoPatrolWorldPath(
  component: AutoPatrolComponent,
  routeTransform: TransformComponent,
  samplesPerSegment = 12,
): Vector3Data[] {
  const points = component.waypoints.map((waypoint) => (
    getSceneCameraPosition(getAutoPatrolWaypointWorldPose(waypoint, routeTransform))
  ));
  if (points.length <= 1) return points;

  const closed = component.playbackMode === 'loop';
  if (component.pathType === 'linear') {
    return closed ? [...points.map(cloneVector), cloneVector(points[0])] : points.map(cloneVector);
  }

  const segmentSamples = Math.max(2, Math.min(64, Math.trunc(samplesPerSegment)));
  const segmentCount = closed ? points.length : points.length - 1;
  const sampled: Vector3Data[] = [];
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const p1Index = segmentIndex;
    const p2Index = (segmentIndex + 1) % points.length;
    const p0Index = closed
      ? (p1Index - 1 + points.length) % points.length
      : Math.max(0, p1Index - 1);
    const p3Index = closed
      ? (p2Index + 1) % points.length
      : Math.min(points.length - 1, p2Index + 1);
    for (let sampleIndex = 0; sampleIndex <= segmentSamples; sampleIndex += 1) {
      if (segmentIndex > 0 && sampleIndex === 0) continue;
      sampled.push(centripetalCatmullRom(
        points[p0Index],
        points[p1Index],
        points[p2Index],
        points[p3Index],
        sampleIndex / segmentSamples,
      ));
    }
  }
  if (closed && sampled.length > 0) sampled[sampled.length - 1] = cloneVector(sampled[0]);
  return sampled;
}

/** 计算一段相机移动；平滑模式沿相机位置和观察目标的 Catmull-Rom 曲线插值。 */
export function interpolateAutoPatrolPose(
  fromPose: SceneCameraPose,
  toPose: SceneCameraPose,
  previousPose: SceneCameraPose,
  nextPose: SceneCameraPose,
  progress: number,
  pathType: AutoPatrolPathType,
  easeAtEndpoints: boolean,
): SceneCameraPose {
  const rawProgress = clampFinite(progress, 0, 1, 0);
  const t = easeAtEndpoints ? smoothStep(rawProgress) : rawProgress;
  const fromPosition = getSceneCameraPosition(fromPose);
  const toPosition = getSceneCameraPosition(toPose);
  const previousPosition = getSceneCameraPosition(previousPose);
  const nextPosition = getSceneCameraPosition(nextPose);
  const position = pathType === 'smooth'
    ? centripetalCatmullRom(previousPosition, fromPosition, toPosition, nextPosition, t)
    : lerpVector(fromPosition, toPosition, t);
  const target = pathType === 'smooth'
    ? centripetalCatmullRom(previousPose.target, fromPose.target, toPose.target, nextPose.target, t)
    : lerpVector(fromPose.target, toPose.target, t);
  return createSceneCameraPose(position, target);
}

function worldPoseToLocalPose(worldPose: SceneCameraPose, routeTransform: TransformComponent): AutoPatrolCameraPose {
  const inverseRotation = conjugateQuaternion(quaternionFromTransform(routeTransform));
  const worldPosition = getSceneCameraPosition(worldPose);
  const localPosition = rotateVector(subtractVector(worldPosition, routeTransform.position), inverseRotation);
  const localTarget = rotateVector(subtractVector(worldPose.target, routeTransform.position), inverseRotation);
  return createSceneCameraPose(localPosition, localTarget);
}

function sanitizeWaypoint(value: unknown): AutoPatrolWaypoint | null {
  if (!isPlainObject(value) || !isPlainObject(value.pose) || !isPlainObject(value.pose.target)) return null;
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!id || id.length > 128) return null;
  const alpha = finiteNumber(value.pose.alpha);
  const beta = finiteNumber(value.pose.beta);
  const radius = finiteNumber(value.pose.radius);
  const target = sanitizeUnknownVector(value.pose.target);
  if (alpha === null || beta === null || radius === null || !target) return null;
  if (value.arrivalActions !== undefined && (!Array.isArray(value.arrivalActions) || value.arrivalActions.length > 0)) {
    return null;
  }
  return {
    id,
    pose: {
      alpha: normalizeRadians(alpha),
      beta: clampFinite(beta, CAMERA_BETA_EPSILON, Math.PI - CAMERA_BETA_EPSILON, Math.PI / 2),
      radius: clampFinite(radius, AUTO_PATROL_MIN_VIEW_DISTANCE, AUTO_PATROL_MAX_VIEW_DISTANCE, 1),
      target,
    },
    travelDurationSeconds: sanitizeDuration(value.travelDurationSeconds),
    dwellSeconds: sanitizeDuration(value.dwellSeconds),
    arrivalActions: [],
  };
}

function sanitizePathType(value: unknown): AutoPatrolPathType | null {
  return value === 'smooth' || value === 'linear' ? value : null;
}

function sanitizePlaybackMode(value: unknown): AutoPatrolPlaybackMode | null {
  return value === 'once' || value === 'loop' || value === 'ping-pong' ? value : null;
}

function sanitizeDuration(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clampFinite(value, 0, AUTO_PATROL_MAX_DURATION_SECONDS, 0)
    : 0;
}

function cloneWaypoint(waypoint: AutoPatrolWaypoint): AutoPatrolWaypoint {
  return {
    id: waypoint.id,
    pose: {
      alpha: waypoint.pose.alpha,
      beta: waypoint.pose.beta,
      radius: waypoint.pose.radius,
      target: cloneVector(waypoint.pose.target),
    },
    travelDurationSeconds: waypoint.travelDurationSeconds,
    dwellSeconds: waypoint.dwellSeconds,
    arrivalActions: [],
  };
}

function createWaypointId(): string {
  return `patrol_waypoint_${globalThis.crypto.randomUUID()}`;
}

function quaternionFromTransform(transform: TransformComponent): QuaternionData {
  const yaw = transform.rotation.y;
  const pitch = transform.rotation.x;
  const roll = transform.rotation.z;
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  const cr = Math.cos(roll / 2);
  const sr = Math.sin(roll / 2);
  return normalizeQuaternion({
    x: cy * sp * cr + sy * cp * sr,
    y: sy * cp * cr - cy * sp * sr,
    z: cy * cp * sr - sy * sp * cr,
    w: cy * cp * cr + sy * sp * sr,
  });
}

function normalizeQuaternion(value: QuaternionData): QuaternionData {
  const length = Math.hypot(value.x, value.y, value.z, value.w);
  if (!Number.isFinite(length) || length <= VECTOR_EPSILON) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: value.x / length, y: value.y / length, z: value.z / length, w: value.w / length };
}

function conjugateQuaternion(value: QuaternionData): QuaternionData {
  return { x: -value.x, y: -value.y, z: -value.z, w: value.w };
}

function rotateVector(vector: Vector3Data, quaternion: QuaternionData): Vector3Data {
  const { x, y, z, w } = quaternion;
  const tx = 2 * (y * vector.z - z * vector.y);
  const ty = 2 * (z * vector.x - x * vector.z);
  const tz = 2 * (x * vector.y - y * vector.x);
  return {
    x: vector.x + w * tx + (y * tz - z * ty),
    y: vector.y + w * ty + (z * tx - x * tz),
    z: vector.z + w * tz + (x * ty - y * tx),
  };
}

function centripetalCatmullRom(
  p0: Vector3Data,
  p1: Vector3Data,
  p2: Vector3Data,
  p3: Vector3Data,
  progress: number,
): Vector3Data {
  const t0 = 0;
  const t1 = t0 + knotDistance(p0, p1);
  const t2 = t1 + knotDistance(p1, p2);
  const t3 = t2 + knotDistance(p2, p3);
  const t = t1 + (t2 - t1) * clampFinite(progress, 0, 1, 0);
  const a1 = interpolateAtKnot(p0, p1, t0, t1, t);
  const a2 = interpolateAtKnot(p1, p2, t1, t2, t);
  const a3 = interpolateAtKnot(p2, p3, t2, t3, t);
  const b1 = interpolateAtKnot(a1, a2, t0, t2, t);
  const b2 = interpolateAtKnot(a2, a3, t1, t3, t);
  return interpolateAtKnot(b1, b2, t1, t2, t);
}

function knotDistance(left: Vector3Data, right: Vector3Data): number {
  return Math.max(1e-4, Math.sqrt(Math.max(VECTOR_EPSILON, vectorLength(subtractVector(right, left)))));
}

function interpolateAtKnot(
  left: Vector3Data,
  right: Vector3Data,
  leftTime: number,
  rightTime: number,
  time: number,
): Vector3Data {
  const span = Math.max(1e-6, rightTime - leftTime);
  return lerpVector(left, right, (time - leftTime) / span);
}

function smoothStep(value: number): number {
  return value * value * (3 - 2 * value);
}

function normalizeRadians(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const normalized = value % (Math.PI * 2);
  return normalized < 0 ? normalized + Math.PI * 2 : normalized;
}

function normalizeDegrees(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function finiteOrFallback(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampFinite(value: number, minimum: number, maximum: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function sanitizeUnknownVector(value: Record<string, unknown>): Vector3Data | null {
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const z = finiteNumber(value.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

function sanitizeVector(value: Vector3Data, fallback: Vector3Data): Vector3Data {
  return {
    x: finiteOrFallback(value.x, fallback.x),
    y: finiteOrFallback(value.y, fallback.y),
    z: finiteOrFallback(value.z, fallback.z),
  };
}

function normalizeVector(value: Vector3Data, fallback: Vector3Data): Vector3Data {
  const length = vectorLength(value);
  return length > VECTOR_EPSILON ? scaleVector(value, 1 / length) : cloneVector(fallback);
}

function vectorLength(value: Vector3Data): number {
  return Math.hypot(value.x, value.y, value.z);
}

function cloneVector(value: Vector3Data): Vector3Data {
  return { x: value.x, y: value.y, z: value.z };
}

function addVector(left: Vector3Data, right: Vector3Data): Vector3Data {
  return { x: left.x + right.x, y: left.y + right.y, z: left.z + right.z };
}

function subtractVector(left: Vector3Data, right: Vector3Data): Vector3Data {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function scaleVector(value: Vector3Data, scale: number): Vector3Data {
  return { x: value.x * scale, y: value.y * scale, z: value.z * scale };
}

function lerpVector(left: Vector3Data, right: Vector3Data, progress: number): Vector3Data {
  const t = clampFinite(progress, 0, 1, 0);
  return {
    x: left.x + (right.x - left.x) * t,
    y: left.y + (right.y - left.y) * t,
    z: left.z + (right.z - left.z) * t,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
