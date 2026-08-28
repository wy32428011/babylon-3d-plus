import type {
  AutoPatrolCameraConfig,
  AutoPatrolComponent,
  AutoPatrolEventDefinition,
  AutoPatrolEventResponse,
  AutoPatrolEventTrigger,
  AutoPatrolPathType,
  AutoPatrolTriggerRegion,
  AutoPatrolWaypoint,
  TransformComponent,
} from './components';
import type { SceneCameraPose } from './SceneDocument';
import type { Vector3Data } from './math';
import {
  cloneAutoPatrolComponent as cloneLegacyAutoPatrolComponent,
  createAutoPatrolWaypointFromWorldPose as createLegacyAutoPatrolWaypointFromWorldPose,
  createDefaultAutoPatrolComponent as createLegacyDefaultAutoPatrolComponent,
  createSceneCameraPose,
  getAutoPatrolWaypointWorldPose,
  getSceneCameraPosition,
  sanitizeAutoPatrolComponent as sanitizeLegacyAutoPatrolComponent,
} from './autoPatrol.js';

export * from './autoPatrol.js';

export const AUTO_PATROL_EYE_HEIGHT_METERS = 1.7;
export const AUTO_PATROL_DEFAULT_SPEED_METERS_PER_SECOND = 1;
export const AUTO_PATROL_MIN_SPEED_METERS_PER_SECOND = 0.1;
export const AUTO_PATROL_MAX_SPEED_METERS_PER_SECOND = 5;
export const AUTO_PATROL_MIN_WAYPOINT_DISTANCE_METERS = 0.5;
export const AUTO_PATROL_ROUTE_JSON_SCHEMA = 'zending-auto-patrol-route';
export const AUTO_PATROL_ROUTE_JSON_VERSION = 1;
export const AUTO_PATROL_ROUTE_JSON_MAX_BYTES = 1_048_576;
export const AUTO_PATROL_ROUTE_JSON_MAX_CHARACTERS = 1_048_576;
export const AUTO_PATROL_BUSINESS_DATA_MAX_STRING_LENGTH = 4_096;
export const AUTO_PATROL_DEFAULT_CAMERA_CONFIG: Readonly<AutoPatrolCameraConfig> = {
  eyeHeightMeters: AUTO_PATROL_EYE_HEIGHT_METERS,
  thirdPersonDistanceMeters: 5,
  thirdPersonHeightMeters: 2.2,
  thirdPersonRotationOffsetDegrees: 0,
  approachDistanceMeters: 2,
  transitionSeconds: 0.5,
};

export type ResolvedAutoPatrolComponent = AutoPatrolComponent & {
  isDefault: boolean;
  tags: string[];
  useRouteSpeed: boolean;
  speedMetersPerSecond: number;
  automaticViewSwitching: boolean;
  camera: AutoPatrolCameraConfig;
  triggerRegions: AutoPatrolTriggerRegion[];
  events: AutoPatrolEventDefinition[];
};

export type AutoPatrolRouteValidationIssue = {
  code: 'too-few-waypoints' | 'waypoints-too-close';
  message: string;
  waypointIndex?: number;
  previousWaypointIndex?: number;
};

export type AutoPatrolRouteJson = {
  schema: typeof AUTO_PATROL_ROUTE_JSON_SCHEMA;
  version: typeof AUTO_PATROL_ROUTE_JSON_VERSION;
  name: string;
  component: ResolvedAutoPatrolComponent;
};

type CreateAutoPatrolWaypointOptions = {
  eyeHeightMeters?: number;
};

const EVENT_RESPONSE_SET = new Set<AutoPatrolEventResponse>([
  'panel',
  'highlight',
  'screenshot',
  'pause',
  'report',
]);
const MAX_TAGS = 16;
const MAX_REGIONS = 128;
const MAX_EVENTS = 256;

/** 新建路线启用 PDF 规定的 1m/s 路线速度和自动视角配置。 */
export function createDefaultAutoPatrolComponent(): ResolvedAutoPatrolComponent {
  return resolveAutoPatrolComponent(createLegacyDefaultAutoPatrolComponent(), { newRoute: true });
}

/**
 * 按真实巡检路径插值相机位姿。Catmull-Rom 的 knot 计算需要外推控制点，
 * 因此中间插值不能把比例限制在 [0, 1]。
 */
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
    : interpolateVector(fromPosition, toPosition, t);
  const target = pathType === 'smooth'
    ? centripetalCatmullRom(previousPose.target, fromPose.target, toPose.target, nextPose.target, t)
    : interpolateVector(fromPose.target, toPose.target, t);
  return createSceneCameraPose(position, target);
}

export function resolveAutoPatrolComponent(
  component: AutoPatrolComponent,
  options: { newRoute?: boolean } = {},
): ResolvedAutoPatrolComponent {
  return {
    ...component,
    isDefault: component.isDefault ?? false,
    tags: [...(component.tags ?? [])],
    useRouteSpeed: component.useRouteSpeed ?? Boolean(options.newRoute),
    speedMetersPerSecond: clampFinite(
      component.speedMetersPerSecond,
      AUTO_PATROL_MIN_SPEED_METERS_PER_SECOND,
      AUTO_PATROL_MAX_SPEED_METERS_PER_SECOND,
      AUTO_PATROL_DEFAULT_SPEED_METERS_PER_SECOND,
    ),
    automaticViewSwitching: component.automaticViewSwitching ?? Boolean(options.newRoute),
    camera: sanitizeCameraConfig(component.camera),
    triggerRegions: (component.triggerRegions ?? []).map(cloneTriggerRegion),
    events: (component.events ?? []).map(cloneEventDefinition),
  };
}

export function createDefaultAutoPatrolTriggerRegion(
  id = createRuntimeId('patrol_region'),
): AutoPatrolTriggerRegion {
  return {
    id,
    name: '新建触发区域',
    enabled: true,
    shape: 'box',
    center: { x: 0, y: 1, z: 0 },
    size: { x: 4, y: 2, z: 4 },
    radiusMeters: 2,
    color: '#ff5a5a',
    alert: false,
  };
}

export function createDefaultAutoPatrolEvent(
  component: Pick<AutoPatrolComponent, 'waypoints'>,
  id = createRuntimeId('patrol_event'),
): AutoPatrolEventDefinition {
  const firstWaypointId = component.waypoints[0]?.id;
  return {
    id,
    name: '新建巡检事件',
    enabled: true,
    anomaly: false,
    trigger: firstWaypointId
      ? { kind: 'waypoint', waypointId: firstWaypointId }
      : { kind: 'manual' },
    responses: ['panel', 'report'],
    targetEntityId: null,
    cooldownSeconds: 5,
    oncePerPatrol: true,
    businessData: {},
  };
}

export function createAutoPatrolWaypointFromWorldPose(
  worldPose: SceneCameraPose,
  routeTransform: TransformComponent,
  id?: string,
  options: CreateAutoPatrolWaypointOptions = {},
): AutoPatrolWaypoint {
  const eyeHeight = options.eyeHeightMeters;
  if (typeof eyeHeight !== 'number' || !Number.isFinite(eyeHeight)) {
    return createLegacyAutoPatrolWaypointFromWorldPose(worldPose, routeTransform, id);
  }
  const position = getSceneCameraPosition(worldPose);
  const direction = normalizeVector(subtractVector(worldPose.target, position), { x: 0, y: 0, z: 1 });
  const normalizedPosition = {
    ...position,
    y: routeTransform.position.y + Math.max(0, eyeHeight),
  };
  const normalizedTarget = addVector(normalizedPosition, scaleVector(direction, worldPose.radius));
  return createLegacyAutoPatrolWaypointFromWorldPose(
    createSceneCameraPose(normalizedPosition, normalizedTarget),
    routeTransform,
    id,
  );
}

export function cloneAutoPatrolComponent(
  component: AutoPatrolComponent,
  options: { disableAutoStart?: boolean } = {},
): ResolvedAutoPatrolComponent {
  const base = cloneLegacyAutoPatrolComponent(component, options);
  const resolved = resolveAutoPatrolComponent(component);
  return {
    ...base,
    isDefault: resolved.isDefault,
    tags: [...resolved.tags],
    useRouteSpeed: resolved.useRouteSpeed,
    speedMetersPerSecond: resolved.speedMetersPerSecond,
    automaticViewSwitching: resolved.automaticViewSwitching,
    camera: { ...resolved.camera },
    triggerRegions: resolved.triggerRegions.map(cloneTriggerRegion),
    events: resolved.events.map(cloneEventDefinition),
    waypoints: base.waypoints.map((waypoint, index) => ({
      ...waypoint,
      arrivalActions: [...(component.waypoints[index]?.arrivalActions ?? [])],
    })),
  };
}

/** 先复用旧路线位姿边界，再清洗新增巡检配置，旧场景不会因缺字段失效。 */
export function sanitizeAutoPatrolComponent(value: unknown): ResolvedAutoPatrolComponent | null {
  if (!isPlainObject(value)) return null;
  const legacyInput = {
    ...value,
    waypoints: Array.isArray(value.waypoints)
      ? value.waypoints.map((waypoint) => isPlainObject(waypoint) ? { ...waypoint, arrivalActions: [] } : waypoint)
      : value.waypoints,
  };
  const base = sanitizeLegacyAutoPatrolComponent(legacyInput);
  if (!base) return null;

  const tags = sanitizeTags(value.tags);
  const triggerRegions = sanitizeTriggerRegions(value.triggerRegions);
  if (!triggerRegions) return null;
  const waypointIds = new Set(base.waypoints.map((waypoint) => waypoint.id));
  const regionIds = new Set(triggerRegions.map((region) => region.id));
  const events = sanitizeEvents(value.events, waypointIds, regionIds);
  if (!events) return null;
  const rawWaypoints = Array.isArray(value.waypoints) ? value.waypoints : [];

  return {
    ...base,
    isDefault: typeof value.isDefault === 'boolean' ? value.isDefault : false,
    tags,
    // 字段缺失表示旧场景，继续使用逐节点时间，避免升级后路线节奏改变。
    useRouteSpeed: typeof value.useRouteSpeed === 'boolean' ? value.useRouteSpeed : false,
    speedMetersPerSecond: clampFinite(
      value.speedMetersPerSecond,
      AUTO_PATROL_MIN_SPEED_METERS_PER_SECOND,
      AUTO_PATROL_MAX_SPEED_METERS_PER_SECOND,
      AUTO_PATROL_DEFAULT_SPEED_METERS_PER_SECOND,
    ),
    automaticViewSwitching: typeof value.automaticViewSwitching === 'boolean'
      ? value.automaticViewSwitching
      : false,
    camera: sanitizeCameraConfig(value.camera),
    triggerRegions,
    events,
    waypoints: base.waypoints.map((waypoint, index) => ({
      ...waypoint,
      arrivalActions: sanitizeIdentifierArray(
        isPlainObject(rawWaypoints[index]) ? rawWaypoints[index].arrivalActions : undefined,
        64,
      ) ?? [],
    })),
  };
}

/** 判断世界点是否位于随路线 Transform 旋转的触发区域内。 */
export function isWorldPointInsideAutoPatrolRegion(
  worldPoint: Vector3Data,
  region: Pick<AutoPatrolTriggerRegion, 'center' | 'size' | 'shape' | 'radiusMeters'>,
  routeTransform: TransformComponent,
): boolean {
  const inverseRotation = conjugateQuaternion(quaternionFromTransform(routeTransform));
  const localPoint = rotateVector(subtractVector(worldPoint, routeTransform.position), inverseRotation);
  if ((region.shape ?? 'box') === 'sphere') {
    const fallbackRadius = Math.max(Math.abs(region.size.x), Math.abs(region.size.y), Math.abs(region.size.z)) / 2;
    const radius = clampFinite(region.radiusMeters, 0.01, 100_000, Math.max(0.01, fallbackRadius));
    return vectorDistance(localPoint, region.center) <= radius + 1e-9;
  }
  const halfSize = {
    x: Math.abs(region.size.x) / 2,
    y: Math.abs(region.size.y) / 2,
    z: Math.abs(region.size.z) / 2,
  };
  return Math.abs(localPoint.x - region.center.x) <= halfSize.x + 1e-9
    && Math.abs(localPoint.y - region.center.y) <= halfSize.y + 1e-9
    && Math.abs(localPoint.z - region.center.z) <= halfSize.z + 1e-9;
}

export type AutoPatrolRegionSegmentIntersection = {
  enterFraction: number;
  leaveFraction: number;
};

/** 返回世界线段进入和离开巡检区域的比例，用于低帧率下补偿窄区域穿越。 */
export function intersectWorldSegmentWithAutoPatrolRegion(
  worldStart: Vector3Data,
  worldEnd: Vector3Data,
  region: Pick<AutoPatrolTriggerRegion, 'center' | 'size' | 'shape' | 'radiusMeters'>,
  routeTransform: TransformComponent,
): AutoPatrolRegionSegmentIntersection | null {
  const inverseRotation = conjugateQuaternion(quaternionFromTransform(routeTransform));
  const localStart = rotateVector(subtractVector(worldStart, routeTransform.position), inverseRotation);
  const localEnd = rotateVector(subtractVector(worldEnd, routeTransform.position), inverseRotation);
  if ((region.shape ?? 'box') === 'sphere') {
    const fallbackRadius = Math.max(Math.abs(region.size.x), Math.abs(region.size.y), Math.abs(region.size.z)) / 2;
    const radius = clampFinite(region.radiusMeters, 0.01, 100_000, Math.max(0.01, fallbackRadius));
    return intersectSegmentSphere(localStart, localEnd, region.center, radius);
  }
  const halfSize = {
    x: Math.abs(region.size.x) / 2,
    y: Math.abs(region.size.y) / 2,
    z: Math.abs(region.size.z) / 2,
  };
  return intersectSegmentBox(localStart, localEnd, {
    x: region.center.x - halfSize.x,
    y: region.center.y - halfSize.y,
    z: region.center.z - halfSize.z,
  }, {
    x: region.center.x + halfSize.x,
    y: region.center.y + halfSize.y,
    z: region.center.z + halfSize.z,
  });
}

/** 对路线执行可持久化的基础校验；巡检播放不依赖场景碰撞或可达性。 */
export function validateAutoPatrolRoute(
  component: Pick<AutoPatrolComponent, 'waypoints'>,
  routeTransform: TransformComponent,
  options: {
    minimumWaypointDistanceMeters?: number;
  } = {},
): AutoPatrolRouteValidationIssue[] {
  if (component.waypoints.length < 2) {
    return [{ code: 'too-few-waypoints', message: '巡检路线至少需要两个节点。' }];
  }

  const minimumDistance = clampFinite(
    options.minimumWaypointDistanceMeters,
    0.01,
    100_000,
    AUTO_PATROL_MIN_WAYPOINT_DISTANCE_METERS,
  );
  const positions = component.waypoints.map((waypoint) => (
    getSceneCameraPosition(getAutoPatrolWaypointWorldPose(waypoint, routeTransform))
  ));
  const issues: AutoPatrolRouteValidationIssue[] = [];
  for (let index = 1; index < positions.length; index += 1) {
    const previous = positions[index - 1];
    const current = positions[index];
    const distance = vectorDistance(previous, current);
    if (distance < minimumDistance) {
      issues.push({
        code: 'waypoints-too-close',
        message: `节点 ${index + 1} 与上一节点距离 ${distance.toFixed(2)}m，小于 ${minimumDistance.toFixed(1)}m。`,
        waypointIndex: index,
        previousWaypointIndex: index - 1,
      });
      continue;
    }
  }
  return issues;
}

export function serializeAutoPatrolRouteJson(component: AutoPatrolComponent, name: string): string {
  const normalized = sanitizeAutoPatrolComponent(component);
  if (!normalized) throw new Error('自动巡检路线数据无效，无法导出。');
  const payload: AutoPatrolRouteJson = {
    schema: AUTO_PATROL_ROUTE_JSON_SCHEMA,
    version: AUTO_PATROL_ROUTE_JSON_VERSION,
    name: sanitizeLabel(name, '自动巡检路线'),
    component: normalized,
  };
  return JSON.stringify(payload, null, 2);
}

export function importAutoPatrolRouteJson(json: string): AutoPatrolRouteJson {
  if (typeof json !== 'string') throw new Error('自动巡检路线 JSON 数据无效。');
  if (json.length > AUTO_PATROL_ROUTE_JSON_MAX_CHARACTERS) {
    throw new Error('自动巡检路线 JSON 不能超过 1 MB。');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('自动巡检路线 JSON 格式无效。');
  }
  if (!isPlainObject(parsed)) throw new Error('自动巡检路线 JSON 数据无效。');
  if (parsed.schema !== AUTO_PATROL_ROUTE_JSON_SCHEMA || parsed.version !== AUTO_PATROL_ROUTE_JSON_VERSION) {
    throw new Error('自动巡检路线 JSON 版本无效或不受支持。');
  }
  const component = sanitizeAutoPatrolComponent(parsed.component);
  if (!component) throw new Error('自动巡检路线配置无效。');
  return {
    schema: AUTO_PATROL_ROUTE_JSON_SCHEMA,
    version: AUTO_PATROL_ROUTE_JSON_VERSION,
    name: sanitizeLabel(parsed.name, '自动巡检路线'),
    component,
  };
}

function sanitizeCameraConfig(value: unknown): AutoPatrolCameraConfig {
  const record = isPlainObject(value) ? value : {};
  return {
    eyeHeightMeters: clampFinite(record.eyeHeightMeters, 0.5, 3, AUTO_PATROL_DEFAULT_CAMERA_CONFIG.eyeHeightMeters),
    thirdPersonDistanceMeters: clampFinite(
      record.thirdPersonDistanceMeters,
      0.5,
      100,
      AUTO_PATROL_DEFAULT_CAMERA_CONFIG.thirdPersonDistanceMeters,
    ),
    thirdPersonHeightMeters: clampFinite(
      record.thirdPersonHeightMeters,
      0,
      100,
      AUTO_PATROL_DEFAULT_CAMERA_CONFIG.thirdPersonHeightMeters,
    ),
    thirdPersonRotationOffsetDegrees: clampFinite(
      record.thirdPersonRotationOffsetDegrees,
      -180,
      180,
      AUTO_PATROL_DEFAULT_CAMERA_CONFIG.thirdPersonRotationOffsetDegrees,
    ),
    approachDistanceMeters: clampFinite(
      record.approachDistanceMeters,
      0.1,
      100,
      AUTO_PATROL_DEFAULT_CAMERA_CONFIG.approachDistanceMeters,
    ),
    transitionSeconds: clampFinite(
      record.transitionSeconds,
      0,
      5,
      AUTO_PATROL_DEFAULT_CAMERA_CONFIG.transitionSeconds,
    ),
  };
}

function sanitizeTriggerRegions(value: unknown): AutoPatrolTriggerRegion[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_REGIONS) return null;
  const ids = new Set<string>();
  const regions: AutoPatrolTriggerRegion[] = [];
  for (const rawRegion of value) {
    if (!isPlainObject(rawRegion) || !isPlainObject(rawRegion.center) || !isPlainObject(rawRegion.size)) return null;
    const id = sanitizeIdentifier(rawRegion.id, 128);
    const center = sanitizeVector(rawRegion.center);
    const size = sanitizeVector(rawRegion.size);
    if (!id || ids.has(id) || !center || !size) return null;
    ids.add(id);
    regions.push({
      id,
      name: sanitizeLabel(rawRegion.name, '未命名触发区域'),
      enabled: typeof rawRegion.enabled === 'boolean' ? rawRegion.enabled : true,
      shape: rawRegion.shape === 'sphere' ? 'sphere' : 'box',
      center,
      size: {
        x: clampFinite(Math.abs(size.x), 0.01, 100_000, 1),
        y: clampFinite(Math.abs(size.y), 0.01, 100_000, 1),
        z: clampFinite(Math.abs(size.z), 0.01, 100_000, 1),
      },
      radiusMeters: clampFinite(
        rawRegion.radiusMeters,
        0.01,
        100_000,
        Math.max(Math.abs(size.x), Math.abs(size.y), Math.abs(size.z)) / 2,
      ),
      color: typeof rawRegion.color === 'string' && /^#[0-9a-f]{6}$/i.test(rawRegion.color)
        ? rawRegion.color.toLowerCase()
        : '#ff5a5a',
      alert: typeof rawRegion.alert === 'boolean' ? rawRegion.alert : false,
    });
  }
  return regions;
}

function sanitizeEvents(
  value: unknown,
  waypointIds: ReadonlySet<string>,
  regionIds: ReadonlySet<string>,
): AutoPatrolEventDefinition[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_EVENTS) return null;
  const ids = new Set<string>();
  const events: AutoPatrolEventDefinition[] = [];
  for (const rawEvent of value) {
    if (!isPlainObject(rawEvent)) return null;
    const id = sanitizeIdentifier(rawEvent.id, 128);
    const trigger = sanitizeEventTrigger(rawEvent.trigger, waypointIds, regionIds);
    const responses = sanitizeEventResponses(rawEvent.responses);
    const businessData = sanitizeBusinessData(rawEvent.businessData);
    if (!id || ids.has(id) || !trigger || !responses || !businessData) return null;
    ids.add(id);
    events.push({
      id,
      name: sanitizeLabel(rawEvent.name, '未命名巡检事件'),
      enabled: typeof rawEvent.enabled === 'boolean' ? rawEvent.enabled : true,
      anomaly: typeof rawEvent.anomaly === 'boolean' ? rawEvent.anomaly : false,
      trigger,
      responses,
      targetEntityId: rawEvent.targetEntityId === null || rawEvent.targetEntityId === undefined
        ? null
        : sanitizeIdentifier(rawEvent.targetEntityId, 256),
      cooldownSeconds: clampFinite(rawEvent.cooldownSeconds, 0, 24 * 60 * 60, 5),
      oncePerPatrol: typeof rawEvent.oncePerPatrol === 'boolean' ? rawEvent.oncePerPatrol : true,
      businessData,
    });
  }
  return events;
}

function sanitizeEventTrigger(
  value: unknown,
  waypointIds: ReadonlySet<string>,
  regionIds: ReadonlySet<string>,
): AutoPatrolEventTrigger | null {
  if (!isPlainObject(value) || typeof value.kind !== 'string') return null;
  if (value.kind === 'manual') return { kind: 'manual' };
  if (value.kind === 'waypoint' || value.kind === 'distance') {
    const waypointId = sanitizeIdentifier(value.waypointId, 128);
    if (!waypointId || !waypointIds.has(waypointId)) return null;
    return value.kind === 'waypoint'
      ? { kind: 'waypoint', waypointId }
      : { kind: 'distance', waypointId, radiusMeters: clampFinite(value.radiusMeters, 0.1, 100_000, 2) };
  }
  if (value.kind === 'region-enter' || value.kind === 'region-leave') {
    const regionId = sanitizeIdentifier(value.regionId, 128);
    return regionId && regionIds.has(regionId) ? { kind: value.kind, regionId } : null;
  }
  return null;
}

function sanitizeEventResponses(value: unknown): AutoPatrolEventResponse[] | null {
  if (!Array.isArray(value) || value.length > EVENT_RESPONSE_SET.size) return null;
  const responses = value.filter((item): item is AutoPatrolEventResponse => (
    typeof item === 'string' && EVENT_RESPONSE_SET.has(item as AutoPatrolEventResponse)
  ));
  return responses.length === value.length ? [...new Set(responses)] : null;
}

function sanitizeBusinessData(value: unknown): AutoPatrolEventDefinition['businessData'] | null {
  if (value === undefined) return {};
  if (!isPlainObject(value) || Object.keys(value).length > 64) return null;
  const result: AutoPatrolEventDefinition['businessData'] = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    const normalizedKey = sanitizeIdentifier(key, 128);
    if (!normalizedKey
      || (typeof fieldValue === 'string' && fieldValue.length > AUTO_PATROL_BUSINESS_DATA_MAX_STRING_LENGTH)
      || !(
        fieldValue === null
        || typeof fieldValue === 'string'
        || typeof fieldValue === 'boolean'
        || (typeof fieldValue === 'number' && Number.isFinite(fieldValue))
      )) return null;
    result[normalizedKey] = fieldValue;
  }
  return result;
}

function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const tags = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, 64))
    .filter(Boolean);
  return [...new Set(tags)].slice(0, MAX_TAGS);
}

function sanitizeIdentifierArray(value: unknown, maximumLength: number): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximumLength) return null;
  const identifiers = value.map((item) => sanitizeIdentifier(item, 128));
  return identifiers.every((item): item is string => Boolean(item)) ? [...new Set(identifiers)] : null;
}

function sanitizeIdentifier(value: unknown, maximumLength: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= maximumLength ? normalized : null;
}

function sanitizeLabel(value: unknown, fallback: string): string {
  return sanitizeIdentifier(value, 128) ?? fallback;
}

function sanitizeVector(value: Record<string, unknown>): Vector3Data | null {
  return typeof value.x === 'number' && Number.isFinite(value.x)
    && typeof value.y === 'number' && Number.isFinite(value.y)
    && typeof value.z === 'number' && Number.isFinite(value.z)
    ? { x: value.x, y: value.y, z: value.z }
    : null;
}

function cloneTriggerRegion(region: AutoPatrolTriggerRegion): AutoPatrolTriggerRegion {
  return {
    ...region,
    shape: region.shape ?? 'box',
    radiusMeters: clampFinite(
      region.radiusMeters,
      0.01,
      100_000,
      Math.max(Math.abs(region.size.x), Math.abs(region.size.y), Math.abs(region.size.z)) / 2,
    ),
    center: { ...region.center },
    size: { ...region.size },
  };
}

function cloneEventDefinition(event: AutoPatrolEventDefinition): AutoPatrolEventDefinition {
  return {
    ...event,
    anomaly: event.anomaly ?? false,
    trigger: { ...event.trigger },
    responses: [...event.responses],
    businessData: { ...event.businessData },
  };
}

function clampFinite(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function vectorDistance(left: Vector3Data, right: Vector3Data): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function centripetalCatmullRom(
  p0: Vector3Data,
  p1: Vector3Data,
  p2: Vector3Data,
  p3: Vector3Data,
  progress: number,
): Vector3Data {
  const t0 = 0;
  const t1 = t0 + catmullRomKnotDistance(p0, p1);
  const t2 = t1 + catmullRomKnotDistance(p1, p2);
  const t3 = t2 + catmullRomKnotDistance(p2, p3);
  const time = t1 + (t2 - t1) * clampFinite(progress, 0, 1, 0);
  const a1 = interpolateVectorAtKnot(p0, p1, t0, t1, time);
  const a2 = interpolateVectorAtKnot(p1, p2, t1, t2, time);
  const a3 = interpolateVectorAtKnot(p2, p3, t2, t3, time);
  const b1 = interpolateVectorAtKnot(a1, a2, t0, t2, time);
  const b2 = interpolateVectorAtKnot(a2, a3, t1, t3, time);
  return interpolateVectorAtKnot(b1, b2, t1, t2, time);
}

function catmullRomKnotDistance(left: Vector3Data, right: Vector3Data): number {
  return Math.max(1e-4, Math.sqrt(Math.max(1e-9, vectorDistance(left, right))));
}

function interpolateVectorAtKnot(
  left: Vector3Data,
  right: Vector3Data,
  leftTime: number,
  rightTime: number,
  time: number,
): Vector3Data {
  const span = Math.max(1e-6, rightTime - leftTime);
  return interpolateVectorUnbounded(left, right, (time - leftTime) / span);
}

function interpolateVector(left: Vector3Data, right: Vector3Data, progress: number): Vector3Data {
  return interpolateVectorUnbounded(left, right, clampFinite(progress, 0, 1, 0));
}

function interpolateVectorUnbounded(left: Vector3Data, right: Vector3Data, progress: number): Vector3Data {
  return {
    x: left.x + (right.x - left.x) * progress,
    y: left.y + (right.y - left.y) * progress,
    z: left.z + (right.z - left.z) * progress,
  };
}

function smoothStep(value: number): number {
  return value * value * (3 - 2 * value);
}

function intersectSegmentSphere(
  start: Vector3Data,
  end: Vector3Data,
  center: Vector3Data,
  radius: number,
): AutoPatrolRegionSegmentIntersection | null {
  const direction = subtractVector(end, start);
  const offset = subtractVector(start, center);
  const a = dotVector(direction, direction);
  if (a <= 1e-18) {
    return dotVector(offset, offset) <= radius * radius + 1e-9
      ? { enterFraction: 0, leaveFraction: 1 }
      : null;
  }
  const b = 2 * dotVector(offset, direction);
  const c = dotVector(offset, offset) - radius * radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -1e-9) return null;
  const root = Math.sqrt(Math.max(0, discriminant));
  const enterFraction = Math.max(0, (-b - root) / (2 * a));
  const leaveFraction = Math.min(1, (-b + root) / (2 * a));
  return enterFraction <= leaveFraction + 1e-9
    ? { enterFraction, leaveFraction }
    : null;
}

function intersectSegmentBox(
  start: Vector3Data,
  end: Vector3Data,
  minimum: Vector3Data,
  maximum: Vector3Data,
): AutoPatrolRegionSegmentIntersection | null {
  const direction = subtractVector(end, start);
  let enterFraction = 0;
  let leaveFraction = 1;
  for (const axis of ['x', 'y', 'z'] as const) {
    const axisDirection = direction[axis];
    if (Math.abs(axisDirection) <= 1e-12) {
      if (start[axis] < minimum[axis] - 1e-9 || start[axis] > maximum[axis] + 1e-9) return null;
      continue;
    }
    let axisEnter = (minimum[axis] - start[axis]) / axisDirection;
    let axisLeave = (maximum[axis] - start[axis]) / axisDirection;
    if (axisEnter > axisLeave) [axisEnter, axisLeave] = [axisLeave, axisEnter];
    enterFraction = Math.max(enterFraction, axisEnter);
    leaveFraction = Math.min(leaveFraction, axisLeave);
    if (enterFraction > leaveFraction + 1e-9) return null;
  }
  return { enterFraction, leaveFraction };
}

function dotVector(left: Vector3Data, right: Vector3Data): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

type QuaternionData = { x: number; y: number; z: number; w: number };

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
  return length > 1e-9
    ? { x: value.x / length, y: value.y / length, z: value.z / length, w: value.w / length }
    : { x: 0, y: 0, z: 0, w: 1 };
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

function normalizeVector(value: Vector3Data, fallback: Vector3Data): Vector3Data {
  const length = Math.hypot(value.x, value.y, value.z);
  return length > 1e-9 ? scaleVector(value, 1 / length) : { ...fallback };
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

function createRuntimeId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}
