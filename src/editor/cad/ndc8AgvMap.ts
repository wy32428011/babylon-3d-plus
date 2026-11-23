import {
  AGV_MAP_MAX_NODES,
  AGV_MAP_MAX_STATIONS,
  AGV_MAP_MAX_TRACK_POINTS,
  AGV_MAP_MAX_TRACKS,
  AGV_MAP_SCHEMA_VERSION,
  sanitizeAgvMapDefinition,
  type AgvMapDefinition,
  type AgvMapPoint,
  type AgvMapStation,
  type AgvMapTrack,
} from '../model/agvMap';
import { convertDxfEntityToPolylines, type DxfEntityRecord } from './cadReferenceCore';
import type { DxfGroupPair } from './cadReferenceLargeDxf';
import type { CadReferenceAgvMapImport } from './cadReferenceWorkerMessages';

const POINT_LAYER = 'ndc8_point';
const POINT_ID_LAYER = 'ndc8_pointid';
const ACTIVITY_LAYER_PREFIX = 'ndc8_activity_';
const STATION_NODE_MATCH_TOLERANCE_METERS = 0.05;
const SYMBOL_LAYER =
  /^ndc8_(?:point(?:id)?|text|drawingline|ignorefalseline|reflector|positionmarker|cluster|activity_.+|group_.+|home_.+)$/;

const getGroup = (groups: readonly DxfGroupPair[], code: number) =>
  groups.find((group) => group.code === code)?.value;
const readTextValue = (groups: readonly DxfGroupPair[]) => {
  let text = '';
  for (const group of groups) {
    if (group.code === 3) text += group.value;
  }
  const tail = getGroup(groups, 1);
  if (tail !== undefined) text += tail;
  return text.trim();
};
const coordinateKey = ({ x, y }: AgvMapPoint) => `${x},${y}`;

/** 过滤全顶点重合的零长度退化折线（如 NDC8 早期导出的 (0,0) 占位箭头）。 */
function isDegeneratePolyline(points: readonly AgvMapPoint[]): boolean {
  if (points.length < 2) return true;
  const first = points[0];
  return points.every((point) => point.x === first.x && point.y === first.y);
}

/** 在未精确重合时，于容差范围内为业务站点匹配唯一最近的路网节点。 */
function findNearestNodeId(
  target: AgvMapPoint,
  centers: readonly AgvMapPoint[],
  nodeIds: readonly string[],
  maxDistance: number,
): string | null {
  const maxDistanceSq = maxDistance * maxDistance;
  let bestIndex = -1;
  let bestDistanceSq = maxDistanceSq;
  let ambiguous = false;
  for (let index = 0; index < centers.length; index += 1) {
    const dx = centers[index].x - target.x;
    const dy = centers[index].y - target.y;
    const distanceSq = dx * dx + dy * dy;
    if (distanceSq > maxDistanceSq) continue;
    if (bestIndex === -1 || distanceSq < bestDistanceSq) {
      bestIndex = index;
      bestDistanceSq = distanceSq;
      ambiguous = false;
    } else if (distanceSq === bestDistanceSq) {
      ambiguous = true;
    }
  }
  if (bestIndex === -1 || ambiguous) return null;
  return nodeIds[bestIndex];
}

/**
 * NDC8 的模型空间按原导出顺序写入点位符号、业务站点、路线中心线及对应编号。
 * 路线中心线后可能紧跟 1 条方向箭头或零长度占位折线，也可能在优化保存为 LWPOLYLINE 后省略无箭头占位。
 */
export function createNdc8AgvMapExtractor(reserveBytes: (bytes: number) => void) {
  const centers: AgvMapPoint[] = [];
  const nodeIds: string[] = [];
  const routes = new Map<string, { name: string; drawings: Array<AgvMapPoint[] | null> }>();
  const routeIds = new Map<string, string[]>();
  const activityLayers = new Map<string, { layer: string; businessType: string; circles: AgvMapPoint[] }>();
  const activityIds = new Map<string, string[]>();
  const activityNames = new Map<string, string[]>();
  let drawingCount = 0;
  let routeIdCount = 0;
  let activityCircleCount = 0;
  let activityIdCount = 0;
  let activityNameCount = 0;

  function addEntity(
    type: string,
    groups: readonly DxfGroupPair[],
    entity: DxfEntityRecord | null,
  ): void {
    if (
      type !== 'TEXT' &&
      type !== 'MTEXT' &&
      type !== 'CIRCLE' &&
      type !== 'POLYLINE' &&
      type !== 'LWPOLYLINE'
    )
      return;
    const layer = getGroup(groups, 8) ?? '';
    const key = layer.toLowerCase();
    if (!key.startsWith('ndc8_') || getGroup(groups, 67) === '1') return;

    if (key.startsWith(ACTIVITY_LAYER_PREFIX)) {
      if (type === 'CIRCLE' && !key.endsWith('id') && !key.endsWith('name')) {
        if (++activityCircleCount > AGV_MAP_MAX_STATIONS)
          throw new Error('NDC8 业务站点数量超过 AGV 地图上限。');
        const x = Number(getGroup(groups, 10));
        const y = Number(getGroup(groups, 20));
        if (!Number.isFinite(x) || !Number.isFinite(y))
          throw new Error(`NDC8 业务站点图层「${layer}」缺少有效的圆心坐标。`);
        let activity = activityLayers.get(key);
        if (!activity) {
          activity = {
            layer,
            businessType: layer.slice(ACTIVITY_LAYER_PREFIX.length).trim(),
            circles: [],
          };
          activityLayers.set(key, activity);
        }
        reserveBytes(128);
        activity.circles.push({ x, y });
        return;
      }
      if (type === 'TEXT' && key.endsWith('id')) {
        const target = key.slice(0, -2);
        const id = readTextValue(groups);
        if (!id || id.length > 128) throw new Error(`NDC8 业务站点图层「${layer}」包含无效编号。`);
        if (++activityIdCount > AGV_MAP_MAX_STATIONS)
          throw new Error('NDC8 业务站点编号数量超过 AGV 地图上限。');
        reserveBytes(64 + id.length * 2);
        const ids = activityIds.get(target) ?? [];
        ids.push(id);
        activityIds.set(target, ids);
        return;
      }
      if ((type === 'MTEXT' || type === 'TEXT') && key.endsWith('name')) {
        const target = key.slice(0, -4);
        const text = readTextValue(groups);
        if (++activityNameCount > AGV_MAP_MAX_STATIONS)
          throw new Error('NDC8 业务站点名称数量超过 AGV 地图上限。');
        reserveBytes(64 + text.length * 2);
        const names = activityNames.get(target) ?? [];
        names.push(text);
        activityNames.set(target, names);
        return;
      }
      return;
    }

    if (type === 'MTEXT') return;

    if (type === 'CIRCLE' && key === POINT_LAYER) {
      if (centers.length >= AGV_MAP_MAX_NODES) throw new Error('NDC8 点位数量超过 AGV 地图上限。');
      const x = Number(getGroup(groups, 10));
      const y = Number(getGroup(groups, 20));
      if (!Number.isFinite(x) || !Number.isFinite(y))
        throw new Error('NDC8 点位缺少有效的圆心坐标。');
      reserveBytes(128);
      centers.push({ x, y });
      return;
    }

    if (type === 'TEXT' && key.endsWith('id')) {
      const target = key.slice(0, -2);
      if (key !== POINT_ID_LAYER && SYMBOL_LAYER.test(target)) return;
      const id = getGroup(groups, 1)?.trim();
      if (!id || id.length > 128) throw new Error(`NDC8 图层「${layer}」包含无效编号。`);
      if (key === POINT_ID_LAYER) {
        if (nodeIds.length >= AGV_MAP_MAX_NODES)
          throw new Error('NDC8 点位编号数量超过 AGV 地图上限。');
        reserveBytes(64 + id.length * 2);
        nodeIds.push(id);
      } else {
        if (++routeIdCount > AGV_MAP_MAX_TRACKS)
          throw new Error('NDC8 路线编号数量超过 AGV 地图上限。');
        reserveBytes(128 + (layer.length + id.length) * 2);
        const ids = routeIds.get(target) ?? [];
        ids.push(id);
        routeIds.set(target, ids);
      }
      return;
    }

    if ((type !== 'POLYLINE' && type !== 'LWPOLYLINE') || SYMBOL_LAYER.test(key)) return;
    if (++drawingCount > 2 * AGV_MAP_MAX_TRACKS)
      throw new Error('NDC8 路线图元数量超过 AGV 地图上限。');
    let route = routes.get(key);
    if (!route) {
      route = { name: layer, drawings: [] };
      routes.set(key, route);
    }
    const points = entity ? convertDxfEntityToPolylines(entity, { x: 0, y: 0 })[0] : undefined;
    if (!points || isDegeneratePolyline(points)) {
      reserveBytes(32);
      route.drawings.push(null);
      return;
    }
    if (points.length > AGV_MAP_MAX_TRACK_POINTS) {
      throw new Error(`NDC8 图层「${layer}」含有无法转换的路线中心线。`);
    }
    reserveBytes(256 + points.length * 64);
    route.drawings.push(points);
  }

  function finish({
    id,
    name,
    unitScaleToMeters,
  }: CadReferenceAgvMapImport & { unitScaleToMeters: number }): AgvMapDefinition {
    if (centers.length === 0 || routes.size === 0)
      throw new Error('DXF 中未找到 NDC8 路网点位和路线。');
    if (centers.length !== nodeIds.length)
      throw new Error('NDC8 点位圆与编号数量不一致，无法确定点位 ID。');
    const toMeters = ({ x, y }: AgvMapPoint) => ({
      x: x * unitScaleToMeters,
      y: y * unitScaleToMeters,
    });
    const idsByCoordinate = new Map(
      centers.map((point, index) => [coordinateKey(point), nodeIds[index]]),
    );
    if (idsByCoordinate.size !== centers.length)
      throw new Error('NDC8 图中有圆心重合的点位，无法唯一匹配路线端点。');
    const nodes = centers.map((point, index) => ({
      id: nodeIds[index],
      name: nodeIds[index],
      ...toMeters(point),
    }));
    const tracks: AgvMapTrack[] = [];
    for (const [key, route] of routes) {
      const ids = routeIds.get(key);
      if (!ids) {
        throw new Error(`NDC8 图层「${route.name}」缺少对应的路线编号。`);
      }
      const centerlines: Array<{
        points: AgvMapPoint[];
        fromNodeId: string;
        toNodeId: string;
      }> = [];
      let canFollowWithArrow = false;
      let hasUnexpectedArrow = false;
      for (const drawing of route.drawings) {
        const fromNodeId = drawing ? idsByCoordinate.get(coordinateKey(drawing[0])) : undefined;
        const toNodeId = drawing
          ? idsByCoordinate.get(coordinateKey(drawing[drawing.length - 1]))
          : undefined;
        if (drawing && fromNodeId && toNodeId) {
          centerlines.push({ points: drawing, fromNodeId, toNodeId });
          canFollowWithArrow = true;
          continue;
        }
        if (!canFollowWithArrow) {
          hasUnexpectedArrow = true;
        } else {
          canFollowWithArrow = false;
        }
      }
      if (centerlines.length !== ids.length) {
        throw new Error(
          `NDC8 图层「${route.name}」的有效路线中心线（${centerlines.length}）与编号数量（${ids.length}）不一致。`,
        );
      }
      if (hasUnexpectedArrow) {
        throw new Error(`NDC8 图层「${route.name}」存在多余或错位的箭头图元。`);
      }
      centerlines.forEach(({ points, fromNodeId, toNodeId }, index) => {
        tracks.push({
          id: ids[index],
          name: route.name,
          fromNodeId,
          toNodeId,
          points: points.map(toMeters),
        });
      });
    }
    for (const layer of routeIds.keys()) {
      if (!routes.has(layer)) throw new Error(`NDC8 路线编号图层「${layer}ID」缺少路线图元。`);
    }
    for (const layer of activityIds.keys()) {
      if (!activityLayers.has(layer))
        throw new Error(`NDC8 业务站点编号图层「${layer}ID」缺少站点图元。`);
    }
    for (const layer of activityNames.keys()) {
      if (!activityLayers.has(layer))
        throw new Error(`NDC8 业务站点名称图层「${layer}Name」缺少站点图元。`);
    }
    const maxStationDistance = STATION_NODE_MATCH_TOLERANCE_METERS / unitScaleToMeters;
    const stations: AgvMapStation[] = [];
    for (const [key, activity] of activityLayers) {
      const ids = activityIds.get(key);
      if (!ids || ids.length !== activity.circles.length) {
        throw new Error(
          `NDC8 业务站点图层「${activity.layer}」的点位数量（${activity.circles.length}）与编号数量（${ids?.length ?? 0}）不一致。`,
        );
      }
      const names = activityNames.get(key);
      if (names && names.length !== activity.circles.length) {
        throw new Error(
          `NDC8 业务站点图层「${activity.layer}」的点位数量（${activity.circles.length}）与名称数量（${names.length}）不一致。`,
        );
      }
      activity.circles.forEach((circle, index) => {
        const stationId = ids[index];
        const nodeId =
          idsByCoordinate.get(coordinateKey(circle)) ??
          findNearestNodeId(circle, centers, nodeIds, maxStationDistance);
        if (!nodeId) {
          throw new Error(
            `NDC8 业务站点「${stationId}」（图层「${activity.layer}」）附近未找到唯一的路网节点。`,
          );
        }
        const rawName = names?.[index]?.trim();
        const stationName = rawName && rawName.length <= 128 ? rawName : stationId;
        stations.push({
          id: stationId,
          name: stationName,
          nodeId,
          ...toMeters(circle),
          ...(activity.businessType ? { businessType: activity.businessType } : {}),
        });
      });
    }
    const map = sanitizeAgvMapDefinition({
      schemaVersion: AGV_MAP_SCHEMA_VERSION,
      id,
      name,
      nodes,
      tracks,
      ...(stations.length > 0 ? { stations } : {}),
    });
    if (!map) throw new Error('NDC8 路网包含重复编号、无效坐标或无效端点。');
    return map;
  }

  return { addEntity, finish };
}
