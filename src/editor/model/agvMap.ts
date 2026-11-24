import type { AgvMapComponent } from './components';
import type { Vector3Data } from './math';

export const AGV_MAP_SCHEMA_VERSION = 1;
export const AGV_MAP_MAX_NODES = 4_096;
export const AGV_MAP_MAX_TRACKS = 8_192;
export const AGV_MAP_MAX_TRACK_POINTS = 2_048;
export const AGV_MAP_MAX_STATIONS = 4_096;
export const AGV_MAP_SCALE_MIN = 0.001;
export const AGV_MAP_SCALE_MAX = 1000;
export const AGV_MAP_SCALE_DEFAULT = 1;
export const AGV_MAP_NODE_RADIUS_MIN = 0.01;
export const AGV_MAP_NODE_RADIUS_MAX = 100;
export const AGV_MAP_NODE_RADIUS_DEFAULT = 0.2;
export const AGV_MAP_SCENE_AXES = ['x', 'y', 'z', '-x', '-y', '-z'] as const;

export type AgvMapSceneAxis = (typeof AGV_MAP_SCENE_AXES)[number];
export type AgvMapPoint = { x: number; y: number };

export const AGV_ROUTE_HIGHLIGHT_STYLES = ['flow-path', 'flow-arrows', 'path-reveal', 'pipe-flow'] as const;
export type AgvRouteHighlightStyle = (typeof AGV_ROUTE_HIGHLIGHT_STYLES)[number];
export type AgvRouteHighlightConfig = {
  enabled: boolean;
  style: AgvRouteHighlightStyle;
  remainingColor: string;
  width: number;
  opacity: number;
  speed: number;
  amount: number;
};

export function createDefaultAgvRouteHighlightConfig(): AgvRouteHighlightConfig {
  return {
    enabled: true,
    style: 'flow-path',
    remainingColor: '#20d9ff',
    width: 0.22,
    opacity: 0.85,
    speed: 1.5,
    amount: 6,
  };
}

export type AgvBusinessNode = AgvMapPoint & {
  id: string;
  name: string;
  businessType?: string;
};

export type AgvMapStation = AgvMapPoint & {
  id: string;
  name: string;
  /** 对应的路网节点 ID（指向 nodes 中的 id）。 */
  nodeId: string;
  businessType?: string;
};

export type AgvMapTrack = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  name?: string;
  bidirectional?: boolean;
  /** 完整有序折线；缺省时使用起点和终点业务节点的坐标。 */
  points?: AgvMapPoint[];
};

export type AgvMapDefinition = {
  schemaVersion: typeof AGV_MAP_SCHEMA_VERSION;
  id: string;
  name: string;
  nodes: AgvBusinessNode[];
  tracks: AgvMapTrack[];
  /** 可选业务站点映射（如 NDC8 的 Ndc8_Activity_*）；独立编号，避免与路网节点撞号。 */
  stations?: AgvMapStation[];
};

export function createDefaultAgvMapComponent(): AgvMapComponent {
  return {
    mapId: null,
    showTrajectories: true,
    showBaseMap: true,
    nodeRadius: AGV_MAP_NODE_RADIUS_DEFAULT,
    routeHighlight: createDefaultAgvRouteHighlightConfig(),
    xAxis: 'x',
    yAxis: 'z',
    scale: AGV_MAP_SCALE_DEFAULT,
  };
}

export function isAgvMapSceneAxis(value: unknown): value is AgvMapSceneAxis {
  return AGV_MAP_SCENE_AXES.includes(value as AgvMapSceneAxis);
}

export function getAgvMapSceneAxisBase(axis: AgvMapSceneAxis): keyof Vector3Data {
  return axis.replace('-', '') as keyof Vector3Data;
}

export function areAgvMapAxesCompatible(xAxis: AgvMapSceneAxis, yAxis: AgvMapSceneAxis): boolean {
  return getAgvMapSceneAxisBase(xAxis) !== getAgvMapSceneAxisBase(yAxis);
}

function sanitizeAgvRouteHighlight(value: unknown): AgvRouteHighlightConfig {
  const defaults = createDefaultAgvRouteHighlightConfig();
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return defaults;
  const record = value as Record<string, unknown>;
  const finite = (key: 'width' | 'opacity' | 'speed' | 'amount', min: number, max: number) => {
    const input = record[key];
    return typeof input === 'number' && Number.isFinite(input)
      ? Math.min(max, Math.max(min, input))
      : defaults[key];
  };
  const color = (key: 'remainingColor') => {
    const input = record[key];
    return typeof input === 'string' && /^#[0-9a-f]{6}$/i.test(input) ? input.toLowerCase() : defaults[key];
  };
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : defaults.enabled,
    style: AGV_ROUTE_HIGHLIGHT_STYLES.includes(record.style as AgvRouteHighlightStyle)
      ? record.style as AgvRouteHighlightStyle
      : defaults.style,
    remainingColor: color('remainingColor'),
    width: finite('width', 0.02, 5),
    opacity: finite('opacity', 0, 1),
    speed: finite('speed', 0, 100),
    amount: Math.round(finite('amount', 1, 64)),
  };
}

/** 清理 AGV 地图显示配置；冲突轴回退到常规地面 X/Z 映射。 */
export function sanitizeAgvMapComponent(value: unknown): AgvMapComponent | null {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const record = value as Record<string, unknown>;
  const mapId = typeof record.mapId === 'string' && record.mapId.trim()
    ? record.mapId.trim().slice(0, 128)
    : null;
  const xAxis = isAgvMapSceneAxis(record.xAxis) ? record.xAxis : 'x';
  const yAxis = isAgvMapSceneAxis(record.yAxis) ? record.yAxis : 'z';
  const axes = areAgvMapAxesCompatible(xAxis, yAxis) ? { xAxis, yAxis } : { xAxis: 'x' as const, yAxis: 'z' as const };
  const rawScale = typeof record.scale === 'number' && Number.isFinite(record.scale)
    ? record.scale
    : AGV_MAP_SCALE_DEFAULT;

  const importedMap = record.importedMap === undefined ? null : sanitizeAgvMapDefinition(record.importedMap);
  if (record.importedMap !== undefined && !importedMap) return null;

  return {
    mapId,
    ...(importedMap ? { importedMap } : {}),
    showTrajectories: typeof record.showTrajectories === 'boolean' ? record.showTrajectories : true,
    showBaseMap: typeof record.showBaseMap === 'boolean' ? record.showBaseMap : true,
    nodeRadius: typeof record.nodeRadius === 'number' && Number.isFinite(record.nodeRadius)
      ? Math.min(AGV_MAP_NODE_RADIUS_MAX, Math.max(AGV_MAP_NODE_RADIUS_MIN, record.nodeRadius))
      : AGV_MAP_NODE_RADIUS_DEFAULT,
    routeHighlight: sanitizeAgvRouteHighlight(record.routeHighlight),
    ...axes,
    scale: Math.min(AGV_MAP_SCALE_MAX, Math.max(AGV_MAP_SCALE_MIN, rawScale)),
  };
}

function normalizeIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().slice(0, 128);
  return normalized || null;
}

function normalizePoint(value: unknown): AgvMapPoint | null {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const point = value as Record<string, unknown>;
  if (typeof point.x !== 'number' || !Number.isFinite(point.x)) return null;
  if (typeof point.y !== 'number' || !Number.isFinite(point.y)) return null;
  return { x: point.x, y: point.y };
}

/** 校验 AGV 地图 JSON；任一引用或坐标非法时整份地图不可用。 */
export function sanitizeAgvMapDefinition(value: unknown): AgvMapDefinition | null {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== AGV_MAP_SCHEMA_VERSION || !Array.isArray(record.nodes) || !Array.isArray(record.tracks)) return null;
  if (record.nodes.length < 1 || record.nodes.length > AGV_MAP_MAX_NODES || record.tracks.length > AGV_MAP_MAX_TRACKS) return null;
  const id = normalizeIdentifier(record.id);
  const name = normalizeIdentifier(record.name);
  if (!id || !name) return null;

  const nodes: AgvBusinessNode[] = [];
  const nodeIds = new Set<string>();
  for (const rawNode of record.nodes) {
    if (typeof rawNode !== 'object' || rawNode === null || Object.getPrototypeOf(rawNode) !== Object.prototype) return null;
    const source = rawNode as Record<string, unknown>;
    const nodeId = normalizeIdentifier(source.id);
    const nodeName = normalizeIdentifier(source.name);
    const point = normalizePoint(source);
    if (!nodeId || !nodeName || !point || nodeIds.has(nodeId)) return null;
    const businessType = source.businessType === undefined ? undefined : normalizeIdentifier(source.businessType);
    if (source.businessType !== undefined && !businessType) return null;
    nodeIds.add(nodeId);
    nodes.push({ id: nodeId, name: nodeName, ...point, ...(businessType ? { businessType } : {}) });
  }

  const tracks: AgvMapTrack[] = [];
  const trackIds = new Set<string>();
  for (const rawTrack of record.tracks) {
    if (typeof rawTrack !== 'object' || rawTrack === null || Object.getPrototypeOf(rawTrack) !== Object.prototype) return null;
    const source = rawTrack as Record<string, unknown>;
    const trackId = normalizeIdentifier(source.id);
    const fromNodeId = normalizeIdentifier(source.fromNodeId);
    const toNodeId = normalizeIdentifier(source.toNodeId);
    if (!trackId || !fromNodeId || !toNodeId || trackIds.has(trackId)) return null;
    if (!nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId)) return null;
    let points: AgvMapPoint[] | undefined;
    if (source.points !== undefined) {
      if (!Array.isArray(source.points) || source.points.length < 2 || source.points.length > AGV_MAP_MAX_TRACK_POINTS) return null;
      const normalizedPoints = source.points.map(normalizePoint);
      if (!normalizedPoints.every((point): point is AgvMapPoint => point !== null)) return null;
      points = normalizedPoints;
    }
    const trackName = source.name === undefined ? undefined : normalizeIdentifier(source.name);
    if (source.name !== undefined && !trackName) return null;
    trackIds.add(trackId);
    tracks.push({
      id: trackId,
      fromNodeId,
      toNodeId,
      ...(trackName ? { name: trackName } : {}),
      ...(source.bidirectional === true ? { bidirectional: true } : {}),
      ...(points ? { points } : {}),
    });
  }

  let stations: AgvMapStation[] | undefined;
  if (record.stations !== undefined) {
    if (!Array.isArray(record.stations) || record.stations.length > AGV_MAP_MAX_STATIONS) return null;
    const normalizedStations: AgvMapStation[] = [];
    const stationIds = new Set<string>();
    for (const rawStation of record.stations) {
      if (typeof rawStation !== 'object' || rawStation === null || Object.getPrototypeOf(rawStation) !== Object.prototype) return null;
      const source = rawStation as Record<string, unknown>;
      const stationId = normalizeIdentifier(source.id);
      const stationName = normalizeIdentifier(source.name);
      const nodeId = normalizeIdentifier(source.nodeId);
      const point = normalizePoint(source);
      if (!stationId || !stationName || !nodeId || !point || stationIds.has(stationId)) return null;
      if (!nodeIds.has(nodeId)) return null;
      const businessType = source.businessType === undefined ? undefined : normalizeIdentifier(source.businessType);
      if (source.businessType !== undefined && !businessType) return null;
      stationIds.add(stationId);
      normalizedStations.push({
        id: stationId,
        name: stationName,
        nodeId,
        ...point,
        ...(businessType ? { businessType } : {}),
      });
    }
    if (normalizedStations.length > 0) stations = normalizedStations;
  }

  return {
    schemaVersion: AGV_MAP_SCHEMA_VERSION,
    id,
    name,
    nodes,
    tracks,
    ...(stations ? { stations } : {}),
  };
}

/** 将 MQTT 站点名称解析为路网节点 ID，并兼容旧站点 ID 和路网节点 ID。 */
export function resolveAgvMapNodeId(map: AgvMapDefinition, pointOrStationName: string): string | null {
  const target = normalizeIdentifier(pointOrStationName);
  if (!target) return null;
  const station = map.stations?.find(item => item.name === target)
    ?? map.stations?.find(item => item.id === target);
  if (station) return station.nodeId;
  return map.nodes.some(node => node.id === target) ? target : null;
}

export function findAgvMapNodeWithinRadius(
  map: AgvMapDefinition,
  point: AgvMapPoint,
  radius: number,
): string | null {
  if (!Number.isFinite(radius) || radius < 0) return null;
  let closestNodeId: string | null = null;
  let closestDistanceSquared = radius * radius;
  for (const node of map.nodes) {
    const distanceSquared = (point.x - node.x) ** 2 + (point.y - node.y) ** 2;
    if (distanceSquared > closestDistanceSquared) continue;
    closestNodeId = node.id;
    closestDistanceSquared = distanceSquared;
  }
  return closestNodeId;
}

export function resolveAgvMapTrackPoints(map: AgvMapDefinition, track: AgvMapTrack): AgvMapPoint[] {
  if (track.points) return track.points;
  const from = map.nodes.find(node => node.id === track.fromNodeId);
  const to = map.nodes.find(node => node.id === track.toNodeId);
  return from && to ? [{ x: from.x, y: from.y }, { x: to.x, y: to.y }] : [];
}

export type AgvMapRoute = {
  nodeIds: string[];
  trackIds: string[];
  points: AgvMapPoint[];
  distance: number;
};

export function sliceAgvMapRouteFromNode(
  map: AgvMapDefinition,
  route: AgvMapRoute,
  startNodeId: string,
): AgvMapRoute | null {
  const startIndex = route.nodeIds.indexOf(startNodeId);
  if (startIndex < 0 || route.trackIds.length !== route.nodeIds.length - 1) return null;
  const nodeIds = route.nodeIds.slice(startIndex);
  const trackIds = route.trackIds.slice(startIndex);
  const tracksById = new Map(map.tracks.map(track => [track.id, track]));
  const points: AgvMapPoint[] = [];
  let distance = 0;
  for (let index = 0; index < trackIds.length; index++) {
    const track = tracksById.get(trackIds[index]);
    if (!track) return null;
    const fromNodeId = nodeIds[index];
    const toNodeId = nodeIds[index + 1];
    const forward = track.fromNodeId === fromNodeId && track.toNodeId === toNodeId;
    const reverse = track.bidirectional === true
      && track.fromNodeId === toNodeId && track.toNodeId === fromNodeId;
    if (!forward && !reverse) return null;
    const trackPoints = resolveAgvMapTrackPoints(map, track);
    if (trackPoints.length < 2) return null;
    const directedPoints = forward ? trackPoints : [...trackPoints].reverse();
    points.push(...(points.length === 0 ? directedPoints : directedPoints.slice(1)));
    distance += measureAgvRoutePoints(directedPoints);
  }
  if (nodeIds.length === 1) {
    const node = map.nodes.find(item => item.id === nodeIds[0]);
    if (!node) return null;
    points.push({ x: node.x, y: node.y });
  }
  return { nodeIds, trackIds, points, distance };
}

export type AgvRouteProjection = {
  point: AgvMapPoint;
  distance: number;
  progress: number;
};

export function projectAgvPointToRoute(points: AgvMapPoint[], point: AgvMapPoint): AgvRouteProjection | null {
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    total += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  if (total <= 0) return null;

  let closest: AgvRouteProjection | null = null;
  let closestDistanceSquared = Number.POSITIVE_INFINITY;
  let traversed = 0;
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1];
    const to = points[index];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length <= 0) continue;
    const fraction = Math.min(1, Math.max(0, ((point.x - from.x) * dx + (point.y - from.y) * dy) / (length * length)));
    const projected = { x: from.x + dx * fraction, y: from.y + dy * fraction };
    const distanceSquared = (point.x - projected.x) ** 2 + (point.y - projected.y) ** 2;
    if (distanceSquared < closestDistanceSquared) {
      const distance = traversed + length * fraction;
      closest = { point: projected, distance, progress: distance / total };
      closestDistanceSquared = distanceSquared;
    }
    traversed += length;
  }
  return closest;
}

type AgvRouteEdge = {
  fromNodeId: string;
  toNodeId: string;
  trackId: string;
  points: AgvMapPoint[];
  distance: number;
};

function measureAgvRoutePoints(points: AgvMapPoint[]): number {
  let distance = 0;
  for (let index = 1; index < points.length; index++) {
    distance += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return distance;
}

/** 按轨迹长度求有向最短路径；仅 bidirectional=true 的路线允许反向通行。 */
export function findAgvMapShortestRoute(
  map: AgvMapDefinition,
  startNodeId: string,
  endNodeId: string,
): AgvMapRoute | null {
  const start = startNodeId.trim();
  const end = endNodeId.trim();
  const nodesById = new Map(map.nodes.map(node => [node.id, node]));
  if (!nodesById.has(start) || !nodesById.has(end)) return null;
  if (start === end) {
    const node = nodesById.get(start)!;
    return { nodeIds: [start], trackIds: [], points: [{ x: node.x, y: node.y }], distance: 0 };
  }

  const adjacency = new Map<string, AgvRouteEdge[]>();
  const addEdge = (edge: AgvRouteEdge) => {
    const edges = adjacency.get(edge.fromNodeId) ?? [];
    edges.push(edge);
    adjacency.set(edge.fromNodeId, edges);
  };
  for (const track of map.tracks) {
    const points = resolveAgvMapTrackPoints(map, track);
    if (points.length < 2) continue;
    const distance = measureAgvRoutePoints(points);
    addEdge({ fromNodeId: track.fromNodeId, toNodeId: track.toNodeId, trackId: track.id, points, distance });
    if (track.bidirectional === true) {
      addEdge({
        fromNodeId: track.toNodeId,
        toNodeId: track.fromNodeId,
        trackId: track.id,
        points: [...points].reverse(),
        distance,
      });
    }
  }

  const distances = new Map<string, number>([[start, 0]]);
  const previous = new Map<string, AgvRouteEdge>();
  const queue: { nodeId: string; distance: number }[] = [{ nodeId: start, distance: 0 }];
  const pushQueue = (entry: { nodeId: string; distance: number }) => {
    let index = queue.length;
    queue.push(entry);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (queue[parent].distance <= entry.distance) break;
      queue[index] = queue[parent];
      index = parent;
    }
    queue[index] = entry;
  };
  const shiftQueue = () => {
    const first = queue[0];
    const last = queue.pop()!;
    if (queue.length > 0) {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        if (left >= queue.length) break;
        const child = right < queue.length && queue[right].distance < queue[left].distance ? right : left;
        if (queue[child].distance >= last.distance) break;
        queue[index] = queue[child];
        index = child;
      }
      queue[index] = last;
    }
    return first;
  };

  while (queue.length > 0) {
    const { nodeId, distance } = shiftQueue();
    if (distance !== distances.get(nodeId)) continue;
    if (nodeId === end) break;
    for (const edge of adjacency.get(nodeId) ?? []) {
      const nextDistance = distance + edge.distance;
      if (nextDistance >= (distances.get(edge.toNodeId) ?? Number.POSITIVE_INFINITY)) continue;
      distances.set(edge.toNodeId, nextDistance);
      previous.set(edge.toNodeId, edge);
      pushQueue({ nodeId: edge.toNodeId, distance: nextDistance });
    }
  }
  if (!previous.has(end)) return null;

  const steps: AgvRouteEdge[] = [];
  let cursor = end;
  while (cursor !== start) {
    const edge = previous.get(cursor);
    if (!edge) return null;
    steps.push(edge);
    cursor = edge.fromNodeId;
  }
  steps.reverse();
  const points: AgvMapPoint[] = [];
  for (const step of steps) {
    points.push(...(points.length === 0 ? step.points : step.points.slice(1)));
  }
  return {
    nodeIds: [start, ...steps.map(step => step.toNodeId)],
    trackIds: steps.map(step => step.trackId),
    points,
    distance: distances.get(end)!,
  };
}

/** 将地图二维点换算为产生器局部三维坐标；比例尺单位为米/地图单位。 */
export function mapAgvPointToScene(
  point: AgvMapPoint,
  component: Pick<AgvMapComponent, 'xAxis' | 'yAxis' | 'scale'>,
): Vector3Data {
  const result: Vector3Data = { x: 0, y: 0, z: 0 };
  const apply = (axis: AgvMapSceneAxis, value: number) => {
    const base = getAgvMapSceneAxisBase(axis);
    const mapped = axis.startsWith('-') ? -value : value;
    result[base] = mapped === 0 ? 0 : mapped;
  };
  apply(component.xAxis, point.x * component.scale);
  apply(component.yAxis, point.y * component.scale);
  return result;
}
