import { parseString } from '@linkiez/dxf-renew';
import type { Block as DxfBlock, Entity as DxfEntity, ParsedDXF, Transform as DxfTransform } from '@linkiez/dxf-renew';
import type {
  CadReferenceBounds,
  CadReferenceComponent,
  CadReferenceLayerStat,
} from '../model/components';
import { createLegacyCadReferenceUnitInfo, resolveDxfUnitInfo } from './cadUnits';
export { CAD_REFERENCE_FALLBACK_UNIT_SCALE_TO_METERS } from './cadUnits';

export const CAD_REFERENCE_DEFAULT_LINE_COLOR = '#35d6ff';
export const CAD_REFERENCE_DEFAULT_OPACITY = 0.58;
export const CAD_REFERENCE_GRID_Y_OFFSET_METERS = 0.01;
export const CAD_REFERENCE_MAX_INSERT_DEPTH = 64;
export const CAD_REFERENCE_MAX_INSERT_ARRAY_INSTANCES = 4_096;
export const CAD_REFERENCE_MAX_ABSOLUTE_COORDINATE = 1e15;
export const CAD_REFERENCE_LARGE_FILE_THRESHOLD_BYTES = 64 * 1024 * 1024;
export const CAD_REFERENCE_LARGE_FILE_GEOMETRY_BUDGET = {
  maxPolylines: 1_000_000,
  maxPoints: 8_000_000,
} as const satisfies CadReferenceGeometryBudget;

const SUPPORTED_DXF_ENTITY_TYPES = new Set([
  'LINE',
  'ARC',
  'CIRCLE',
  'ELLIPSE',
  'SPLINE',
  'LWPOLYLINE',
  'POLYLINE',
]);
const CAD_REFERENCE_ARC_SEGMENT_RADIANS = (5 / 180) * Math.PI;
const CAD_REFERENCE_CIRCLE_SEGMENT_COUNT = 72;
const CAD_REFERENCE_SPLINE_MIN_SEGMENT_COUNT = 8;
const CAD_REFERENCE_SPLINE_MAX_SEGMENT_COUNT = 96;
const CAD_REFERENCE_SPLINE_SEGMENTS_PER_CONTROL_POINT = 3;

type CadReferencePoint2D = {
  x: number;
  y: number;
};

export type CadReferenceGeometryLayer = {
  name: string;
  positions: Float32Array;
  polylinePointCounts: Uint32Array;
  entityCount: number;
  polylineCount: number;
  pointCount: number;
};

export type CadReferenceParseResult = {
  sourceUnitCode: number | null;
  sourceUnitName: string;
  unitDetection: CadReferenceComponent['unitDetection'];
  unitScaleToMeters: number;
  layerStats: CadReferenceLayerStat[];
  bounds: CadReferenceBounds;
  polylineCount: number;
  pointCount: number;
  layers: CadReferenceGeometryLayer[];
  budgetLimited: boolean;
};

export type CadReferenceGeometryBudget = {
  maxPolylines: number;
  maxPoints: number;
};

export type CadReferenceParseOptions = {
  unitScaleToMeters?: number;
  geometryBudget?: CadReferenceGeometryBudget;
};

type CadReferenceParseResultCacheEntry = {
  result: CadReferenceParseResult;
  timeoutId: ReturnType<typeof setTimeout> | null;
};

type Bounds2D = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type DxfEntityRecord = DxfEntity & {
  type?: unknown;
  layer?: unknown;
  extrusionZ?: unknown;
};

type DxfInsertEntityRecord = DxfEntityRecord & {
  block?: unknown;
  x?: unknown;
  y?: unknown;
  scaleX?: unknown;
  scaleY?: unknown;
  scaleZ?: unknown;
  rotation?: unknown;
  columnCount?: unknown;
  rowCount?: unknown;
  columnSpacing?: unknown;
  rowSpacing?: unknown;
  extrusionX?: unknown;
  extrusionY?: unknown;
  extrusionZ?: unknown;
};

type DxfLineEntityRecord = DxfEntityRecord & {
  start?: unknown;
  end?: unknown;
};

type DxfPositionalEntityRecord = DxfEntityRecord & {
  x?: unknown;
  y?: unknown;
  r?: unknown;
  startAngle?: unknown;
  endAngle?: unknown;
};

type DxfPolylineEntityRecord = DxfEntityRecord & {
  vertices?: unknown;
  closed?: unknown;
  polygonMesh?: unknown;
  polyfaceMesh?: unknown;
};

type DxfEllipseEntityRecord = DxfEntityRecord & {
  x?: unknown;
  y?: unknown;
  majorX?: unknown;
  majorY?: unknown;
  axisRatio?: unknown;
  startAngle?: unknown;
  endAngle?: unknown;
};

type DxfSplineEntityRecord = DxfEntityRecord & {
  controlPoints?: unknown;
  knots?: unknown;
  weights?: unknown;
  degree?: unknown;
  closed?: unknown;
};

type DxfVertexRecord = {
  x?: unknown;
  y?: unknown;
  bulge?: unknown;
};

type CadRawLayer = {
  coordinates: number[];
  polylinePointCounts: number[];
  entityCount: number;
  polylineCount: number;
  pointCount: number;
};

type CadInsertTraversalItem = {
  entities: DxfEntityRecord[];
  transforms: DxfTransform[];
  blockBasePoint: CadReferencePoint2D;
  layerOverride: string | null;
  depth: number;
  blockPath: string[];
};

const CAD_REFERENCE_PARSE_RESULT_CACHE_TTL_MS = 5 * 60 * 1000;
const cadReferenceParseResultCache = new Map<string, CadReferenceParseResultCacheEntry>();

/** 解析 DXF 文本并转换为贴近 Babylon 网格层的米制线稿数据。 */
export function parseCadReferenceDxf(content: string, options: CadReferenceParseOptions = {}): CadReferenceParseResult {
  return convertParsedCadReferenceDxf(parseDxfContent(content), options);
}

/** 将已解析的 DXF 结构转换为 CAD 参考层几何，供精确解析和大文件预扫描路径复用。 */
export function convertParsedCadReferenceDxf(parsed: ParsedDXF, options: CadReferenceParseOptions = {}): CadReferenceParseResult {
  const detectedUnitInfo = resolveDxfUnitInfo(parsed.header);
  const unitInfo = options.unitScaleToMeters === undefined || options.unitScaleToMeters === detectedUnitInfo.unitScaleToMeters
    ? detectedUnitInfo
    : createLegacyCadReferenceUnitInfo(options.unitScaleToMeters);
  const unitScaleToMeters = unitInfo.unitScaleToMeters;
  const geometryBudget = normalizeCadReferenceGeometryBudget(options.geometryBudget);
  const rawLayerMap = new Map<string, CadRawLayer>();
  let originalBounds: Bounds2D | null = null;
  let polylineCount = 0;
  let pointCount = 0;
  let budgetLimited = false;

  traverseDxfEntities(parsed, (entity, traversal) => {
    if (!isSupportedDxfEntity(entity)) return;

    const rawPoints = convertDxfEntityToPolyline(entity, traversal.blockBasePoint);
    if (rawPoints.length < 2) return;

    let points = transformCadPolyline(rawPoints, traversal.transforms);
    if (points.length < 2) return;

    if (geometryBudget) {
      if (polylineCount >= geometryBudget.maxPolylines) {
        budgetLimited = true;
        return false;
      }

      const remainingPointCount = geometryBudget.maxPoints - pointCount;
      if (remainingPointCount < 2) {
        budgetLimited = true;
        return false;
      }
      if (points.length > remainingPointCount) {
        points = sampleCadPolyline(points, remainingPointCount);
        budgetLimited = true;
      }
    }

    const layerName = traversal.layerOverride ?? readDxfEntityLayerName(entity);
    const layer = readOrCreateRawLayer(rawLayerMap, layerName);
    layer.polylinePointCounts.push(points.length);
    layer.entityCount += 1;
    layer.polylineCount += 1;
    layer.pointCount += points.length;

    polylineCount += 1;
    pointCount += points.length;

    for (const point of points) {
      layer.coordinates.push(point.x, point.y);
      originalBounds = expandBounds2D(originalBounds, point);
    }
  }, () => {
    budgetLimited = true;
  });

  if (!originalBounds || rawLayerMap.size === 0) {
    throw new Error('DXF 中没有可显示的 LINE、ARC、CIRCLE、LWPOLYLINE 或 POLYLINE 图元。');
  }

  const resolvedOriginalBounds = originalBounds as Bounds2D;
  const originalCenter = {
    x: (resolvedOriginalBounds.minX + resolvedOriginalBounds.maxX) / 2,
    y: (resolvedOriginalBounds.minY + resolvedOriginalBounds.maxY) / 2,
  };
  const layers: CadReferenceGeometryLayer[] = [];
  const transformedBounds = createCadReferenceBounds(resolvedOriginalBounds, unitScaleToMeters);

  for (const [layerName, rawLayer] of rawLayerMap.entries()) {
    const positions = new Float32Array(rawLayer.pointCount * 3);
    let positionOffset = 0;
    for (let coordinateOffset = 0; coordinateOffset < rawLayer.coordinates.length; coordinateOffset += 2) {
      positions[positionOffset] = (rawLayer.coordinates[coordinateOffset] - originalCenter.x) * unitScaleToMeters;
      positions[positionOffset + 1] = CAD_REFERENCE_GRID_Y_OFFSET_METERS;
      positions[positionOffset + 2] = (rawLayer.coordinates[coordinateOffset + 1] - originalCenter.y) * unitScaleToMeters;
      positionOffset += 3;
    }

    layers.push({
      name: layerName,
      positions,
      polylinePointCounts: Uint32Array.from(rawLayer.polylinePointCounts),
      entityCount: rawLayer.entityCount,
      polylineCount: rawLayer.polylineCount,
      pointCount: rawLayer.pointCount,
    });
  }

  const layerStats = layers.map(({ name, entityCount, polylineCount: layerPolylineCount, pointCount: layerPointCount }) => ({
    name,
    entityCount,
    polylineCount: layerPolylineCount,
    pointCount: layerPointCount,
  }));

  return {
    sourceUnitCode: unitInfo.sourceUnitCode,
    sourceUnitName: unitInfo.sourceUnitName,
    unitDetection: unitInfo.unitDetection,
    unitScaleToMeters,
    layerStats,
    bounds: transformedBounds,
    polylineCount,
    pointCount,
    layers,
    budgetLimited,
  };
}

/** 规整 CAD 几何预算，保证大文件后台解析始终有确定上限。 */
function normalizeCadReferenceGeometryBudget(budget: CadReferenceGeometryBudget | undefined): CadReferenceGeometryBudget | null {
  if (!budget) return null;

  return {
    maxPolylines: Math.max(1, Math.floor(readFiniteNumber(budget.maxPolylines, 1))),
    maxPoints: Math.max(2, Math.floor(readFiniteNumber(budget.maxPoints, 2))),
  };
}

/** 按固定数量均匀抽样超长折线，并始终保留首尾点。 */
function sampleCadPolyline(points: CadReferencePoint2D[], maxPointCount: number): CadReferencePoint2D[] {
  if (points.length <= maxPointCount) return points;
  if (maxPointCount <= 2) return [points[0], points[points.length - 1]];

  const sampled: CadReferencePoint2D[] = [];
  for (let index = 0; index < maxPointCount; index += 1) {
    const sourceIndex = Math.round((index * (points.length - 1)) / (maxPointCount - 1));
    sampled.push(points[sourceIndex]);
  }
  return sampled;
}

/** 暂存刚导入的 CAD 几何，供同一轮 runtime 同步复用，避免大文件马上二次解析。 */
export function rememberCadReferenceParseResult(sourceUrl: string, result: CadReferenceParseResult): void {
  const key = createCadReferenceParseResultCacheKey(sourceUrl, result.unitScaleToMeters);
  const previous = cadReferenceParseResultCache.get(key);
  if (previous?.timeoutId !== null && previous?.timeoutId !== undefined) clearTimeout(previous.timeoutId);

  const timeoutId = setTimeout(() => {
    cadReferenceParseResultCache.delete(key);
  }, CAD_REFERENCE_PARSE_RESULT_CACHE_TTL_MS);

  cadReferenceParseResultCache.set(key, { result, timeoutId });
}

/** 读取并删除一次性 CAD 几何缓存；场景重新加载时仍会按 sourceUrl 重新解析源文件。 */
export function consumeCadReferenceParseResult(
  sourceUrl: string,
  unitScaleToMeters: number,
): CadReferenceParseResult | null {
  const key = createCadReferenceParseResultCacheKey(sourceUrl, unitScaleToMeters);
  const entry = cadReferenceParseResultCache.get(key);
  if (!entry) return null;

  if (entry.timeoutId !== null) clearTimeout(entry.timeoutId);
  cadReferenceParseResultCache.delete(key);
  return entry.result;
}

/** 根据解析结果生成可写入 SceneDocument 的 CAD 参考组件元数据。 */
export function createCadReferenceComponentMetadata(
  result: CadReferenceParseResult,
  source: Pick<CadReferenceComponent, 'sourceFileSizeBytes' | 'importMode'> = { sourceFileSizeBytes: 0, importMode: 'exact' },
): Omit<CadReferenceComponent, 'sourcePath' | 'sourceUrl'> {
  return {
    sourceFileSizeBytes: source.sourceFileSizeBytes,
    importMode: source.importMode,
    sourceUnitCode: result.sourceUnitCode,
    sourceUnitName: result.sourceUnitName,
    unitDetection: result.unitDetection,
    unitScaleToMeters: result.unitScaleToMeters,
    originMode: 'center',
    lineColor: CAD_REFERENCE_DEFAULT_LINE_COLOR,
    opacity: CAD_REFERENCE_DEFAULT_OPACITY,
    layerStats: result.layerStats,
    bounds: result.bounds,
    polylineCount: result.polylineCount,
    pointCount: result.pointCount,
  };
}

/** 将 Inspector 写入值限制在 CAD 参考层允许的显示范围内。 */
export function sanitizeCadReferenceDisplayPatch(
  cadReference: CadReferenceComponent,
  patch: Partial<Pick<CadReferenceComponent, 'lineColor' | 'opacity'>>,
): CadReferenceComponent {
  return {
    ...cadReference,
    lineColor: patch.lineColor && isColorLike(patch.lineColor) ? patch.lineColor : cadReference.lineColor,
    opacity: patch.opacity === undefined ? cadReference.opacity : clampOpacity(patch.opacity, cadReference.opacity),
  };
}

/** 组合缓存键，单位换算不同的同一文件必须视为不同几何。 */
function createCadReferenceParseResultCacheKey(sourceUrl: string, unitScaleToMeters: number): string {
  return `${sourceUrl}\n${unitScaleToMeters}`;
}

/** 调用第三方基础解析器并把失败信息转换为用户可读中文。 */
function parseDxfContent(content: string): ParsedDXF {
  try {
    return parseString(content) as ParsedDXF;
  } catch (error) {
    throw new Error(`CAD/DXF 解析失败：${readErrorMessage(error)}`);
  }
}

/** 用显式栈迭代展开 INSERT 块引用，避免复杂图纸递归展开时栈溢出。 */
function traverseDxfEntities(
  parsed: ParsedDXF,
  visitEntity: (entity: DxfEntityRecord, traversal: CadInsertTraversalItem) => boolean | void,
  onTraversalLimited: () => void = () => undefined,
): void {
  const blocksByName = createBlocksByName(parsed.blocks);
  const stack: CadInsertTraversalItem[] = [{
    entities: normalizeDxfEntityArray(parsed.entities),
    transforms: [],
    blockBasePoint: { x: 0, y: 0 },
    layerOverride: null,
    depth: 0,
    blockPath: [],
  }];

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item) continue;

    for (const entity of item.entities) {
      if (entity.type === 'INSERT') {
        if (pushInsertTraversalItems(entity as DxfInsertEntityRecord, item, blocksByName, stack)) {
          onTraversalLimited();
        }
        continue;
      }

      if (visitEntity(entity, item) === false) return;
    }
  }
}

/** 建立块名称索引，展开 INSERT 时可以 O(1) 找到被引用块。 */
function createBlocksByName(blocks: DxfBlock[] | undefined): Map<string, DxfBlock> {
  const result = new Map<string, DxfBlock>();
  for (const block of blocks ?? []) {
    if (typeof block.name === 'string' && block.name) {
      result.set(block.name, block);
    }
  }
  return result;
}

/** 把解析器实体数组归一为可安全读取的记录数组。 */
function normalizeDxfEntityArray(entities: DxfEntity[] | undefined): DxfEntityRecord[] {
  return (entities ?? []).filter(isRecord) as DxfEntityRecord[];
}

/** 将 INSERT 引用转换为后续遍历项，循环引用和过深嵌套会被跳过。 */
function pushInsertTraversalItems(
  insert: DxfInsertEntityRecord,
  parent: CadInsertTraversalItem,
  blocksByName: Map<string, DxfBlock>,
  stack: CadInsertTraversalItem[],
): boolean {
  const blockName = typeof insert.block === 'string' ? insert.block : '';
  const block = blockName ? blocksByName.get(blockName) : undefined;
  if (!block || parent.depth >= CAD_REFERENCE_MAX_INSERT_DEPTH || parent.blockPath.includes(blockName)) {
    return false;
  }

  const rowCount = readPositiveInteger(insert.rowCount, 1);
  const columnCount = readPositiveInteger(insert.columnCount, 1);
  const { rowVec, colVec } = computeInsertArrayVectors(insert);
  const insertLayer = parent.layerOverride ?? readDxfEntityLayerName(insert);
  const insertX = readFiniteNumber(insert.x, 0) - parent.blockBasePoint.x;
  const insertY = readFiniteNumber(insert.y, 0) - parent.blockBasePoint.y;
  const childBlockBasePoint = {
    x: readFiniteNumber(block.x, 0),
    y: readFiniteNumber(block.y, 0),
  };
  const childEntities = normalizeDxfEntityArray(block.entities);
  const childBlockPath = [...parent.blockPath, blockName];

  const totalInstanceCount = rowCount * columnCount;
  let pushedInstanceCount = 0;
  for (let rowIndex = rowCount - 1; rowIndex >= 0; rowIndex -= 1) {
    for (let columnIndex = columnCount - 1; columnIndex >= 0; columnIndex -= 1) {
      if (pushedInstanceCount >= CAD_REFERENCE_MAX_INSERT_ARRAY_INSTANCES) {
        return totalInstanceCount > pushedInstanceCount;
      }
      const transform: DxfTransform = {
        x: insertX + rowVec.x * rowIndex + colVec.x * columnIndex,
        y: insertY + rowVec.y * rowIndex + colVec.y * columnIndex,
        scaleX: readFiniteNumber(insert.scaleX, 1),
        scaleY: readFiniteNumber(insert.scaleY, 1),
        scaleZ: readFiniteNumber(insert.scaleZ, 1),
        rotation: readFiniteNumber(insert.rotation, 0),
        extrusionX: readOptionalFiniteNumber(insert.extrusionX),
        extrusionY: readOptionalFiniteNumber(insert.extrusionY),
        extrusionZ: readOptionalFiniteNumber(insert.extrusionZ),
      };

      stack.push({
        entities: childEntities,
        transforms: [transform, ...parent.transforms],
        blockBasePoint: childBlockBasePoint,
        layerOverride: insertLayer,
        depth: parent.depth + 1,
        blockPath: childBlockPath,
      });
      pushedInstanceCount += 1;
    }
  }

  return totalInstanceCount > pushedInstanceCount;
}

/** 计算 INSERT 矩形阵列在局部坐标系中的行列偏移。 */
function computeInsertArrayVectors(insert: DxfInsertEntityRecord): { rowVec: CadReferencePoint2D; colVec: CadReferencePoint2D } {
  const rowCount = readPositiveInteger(insert.rowCount, 1);
  const columnCount = readPositiveInteger(insert.columnCount, 1);
  const rowSpacing = readFiniteNumber(insert.rowSpacing, 0);
  const columnSpacing = readFiniteNumber(insert.columnSpacing, 0);
  const rotation = (readFiniteNumber(insert.rotation, 0) / 180) * Math.PI;

  if (rowCount <= 1 && columnCount <= 1) {
    return { rowVec: { x: 0, y: 0 }, colVec: { x: 0, y: 0 } };
  }

  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  return {
    rowVec: { x: -sin * rowSpacing, y: cos * rowSpacing },
    colVec: { x: cos * columnSpacing, y: sin * columnSpacing },
  };
}

/** 判断当前 DXF 图元是否属于首版承诺显示的线稿类型。 */
function isSupportedDxfEntity(entity: DxfEntityRecord): boolean {
  return typeof entity.type === 'string' && SUPPORTED_DXF_ENTITY_TYPES.has(entity.type);
}

/** 从 DXF 图元读取图层名称，缺失时回退到默认 0 图层。 */
function readDxfEntityLayerName(entity: DxfEntityRecord | undefined): string {
  return typeof entity?.layer === 'string' && entity.layer.trim() ? entity.layer.trim() : '0';
}

/** 读取或创建图层聚合桶，用于保留后续 Inspector 图层统计。 */
function readOrCreateRawLayer(rawLayerMap: Map<string, CadRawLayer>, layerName: string): CadRawLayer {
  const existing = rawLayerMap.get(layerName);
  if (existing) return existing;

  const created: CadRawLayer = {
    coordinates: [],
    polylinePointCounts: [],
    entityCount: 0,
    polylineCount: 0,
    pointCount: 0,
  };
  rawLayerMap.set(layerName, created);
  return created;
}

/** 按实体类型把二维 CAD 图元折线化为局部 DXF 坐标点。 */
function convertDxfEntityToPolyline(entity: DxfEntityRecord, blockBasePoint: CadReferencePoint2D): CadReferencePoint2D[] {
  switch (entity.type) {
    case 'LINE':
      return convertDxfLineToPolyline(entity as DxfLineEntityRecord, blockBasePoint);
    case 'ARC':
      return convertDxfArcToPolyline(entity as DxfPositionalEntityRecord, blockBasePoint);
    case 'CIRCLE':
      return convertDxfCircleToPolyline(entity as DxfPositionalEntityRecord, blockBasePoint);
    case 'ELLIPSE':
      return convertDxfEllipseToPolyline(entity as DxfEllipseEntityRecord, blockBasePoint);
    case 'SPLINE':
      return convertDxfSplineToPolyline(entity as DxfSplineEntityRecord, blockBasePoint);
    case 'LWPOLYLINE':
    case 'POLYLINE':
      return convertDxfPolylineToPolyline(entity as DxfPolylineEntityRecord, blockBasePoint);
    default:
      return [];
  }
}

/** 将 LINE 转成两个端点。 */
function convertDxfLineToPolyline(entity: DxfLineEntityRecord, blockBasePoint: CadReferencePoint2D): CadReferencePoint2D[] {
  const start = readPoint2D(entity.start, blockBasePoint);
  const end = readPoint2D(entity.end, blockBasePoint);
  return start && end ? applyEntityExtrusion([start, end], entity) : [];
}

/** 将 ARC 按固定角度步长采样为折线。 */
function convertDxfArcToPolyline(entity: DxfPositionalEntityRecord, blockBasePoint: CadReferencePoint2D): CadReferencePoint2D[] {
  const center = readPositionalCenter(entity, blockBasePoint);
  const radius = readFiniteNumber(entity.r, 0);
  const startAngle = readFiniteNumber(entity.startAngle, 0);
  let endAngle = readFiniteNumber(entity.endAngle, 0);
  if (!center || radius <= 0) return [];

  while (endAngle < startAngle) {
    endAngle += Math.PI * 2;
  }

  const sweep = endAngle - startAngle;
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / CAD_REFERENCE_ARC_SEGMENT_RADIANS));
  const points: CadReferencePoint2D[] = [];

  for (let index = 0; index <= segments; index += 1) {
    const angle = startAngle + (sweep * index) / segments;
    points.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  }

  return applyEntityExtrusion(points, entity);
}

/** 将 CIRCLE 采样为闭合折线。 */
function convertDxfCircleToPolyline(entity: DxfPositionalEntityRecord, blockBasePoint: CadReferencePoint2D): CadReferencePoint2D[] {
  const center = readPositionalCenter(entity, blockBasePoint);
  const radius = readFiniteNumber(entity.r, 0);
  if (!center || radius <= 0) return [];

  const points: CadReferencePoint2D[] = [];
  for (let index = 0; index <= CAD_REFERENCE_CIRCLE_SEGMENT_COUNT; index += 1) {
    const angle = (Math.PI * 2 * index) / CAD_REFERENCE_CIRCLE_SEGMENT_COUNT;
    points.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  }

  return applyEntityExtrusion(points, entity);
}

/** 将 ELLIPSE 按长轴向量和轴比采样为折线。 */
function convertDxfEllipseToPolyline(entity: DxfEllipseEntityRecord, blockBasePoint: CadReferencePoint2D): CadReferencePoint2D[] {
  const center = readPositionalCenter(entity, blockBasePoint);
  const majorX = readFiniteNumber(entity.majorX, Number.NaN);
  const majorY = readFiniteNumber(entity.majorY, Number.NaN);
  const axisRatio = Math.abs(readFiniteNumber(entity.axisRatio, 0));
  const radiusX = Math.hypot(majorX, majorY);
  const radiusY = radiusX * axisRatio;
  const startAngle = readFiniteNumber(entity.startAngle, 0);
  let endAngle = readFiniteNumber(entity.endAngle, Math.PI * 2);
  if (!center || !Number.isFinite(radiusX) || radiusX <= 0 || radiusY <= 0) return [];

  while (endAngle < startAngle) endAngle += Math.PI * 2;
  const sweep = endAngle - startAngle;
  const segments = Math.max(1, Math.ceil(Math.abs(sweep) / CAD_REFERENCE_ARC_SEGMENT_RADIANS));
  const rotation = Math.atan2(majorY, majorX);
  const cosRotation = Math.cos(rotation);
  const sinRotation = Math.sin(rotation);
  const points: CadReferencePoint2D[] = [];

  for (let index = 0; index <= segments; index += 1) {
    const angle = startAngle + (sweep * index) / segments;
    const localX = Math.cos(angle) * radiusX;
    const localY = Math.sin(angle) * radiusY;
    points.push({
      x: center.x + localX * cosRotation - localY * sinRotation,
      y: center.y + localX * sinRotation + localY * cosRotation,
    });
  }

  return applyEntityExtrusion(points, entity);
}

/** 将 SPLINE 通过有界 de Boor 采样转换为折线，避免复杂曲线造成无界点数。 */
function convertDxfSplineToPolyline(entity: DxfSplineEntityRecord, blockBasePoint: CadReferencePoint2D): CadReferencePoint2D[] {
  if (!Array.isArray(entity.controlPoints)) return [];

  const controlPoints = entity.controlPoints
    .filter(isRecord)
    .map((point) => readPoint2D(point, blockBasePoint))
    .filter((point): point is CadReferencePoint2D => Boolean(point));
  if (controlPoints.length < 2) return [];

  const degree = Math.max(1, Math.floor(readFiniteNumber(entity.degree, 1)));
  const knots = Array.isArray(entity.knots)
    ? entity.knots.map((value) => readFiniteNumber(value, Number.NaN)).filter(Number.isFinite)
    : [];
  const weights = Array.isArray(entity.weights)
    ? entity.weights.map((value) => readFiniteNumber(value, 1))
    : undefined;
  if (degree >= controlPoints.length || knots.length < controlPoints.length + degree + 1) {
    return applyEntityExtrusion(controlPoints, entity);
  }

  const start = knots[degree];
  const end = knots[knots.length - degree - 1];
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return applyEntityExtrusion(controlPoints, entity);
  }

  const segmentCount = Math.min(
    CAD_REFERENCE_SPLINE_MAX_SEGMENT_COUNT,
    Math.max(CAD_REFERENCE_SPLINE_MIN_SEGMENT_COUNT, (controlPoints.length - 1) * CAD_REFERENCE_SPLINE_SEGMENTS_PER_CONTROL_POINT),
  );
  const points: CadReferencePoint2D[] = [];
  for (let index = 0; index <= segmentCount; index += 1) {
    const parameter = index === segmentCount ? end : start + ((end - start) * index) / segmentCount;
    const point = evaluateDxfSplinePoint(controlPoints, degree, knots, weights, parameter);
    if (point && isFinitePoint2D(point)) points.push(point);
  }

  if (entity.closed && points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (first.x !== last.x || first.y !== last.y) points.push({ ...first });
  }

  return applyEntityExtrusion(points, entity);
}

/** 使用齐次坐标 de Boor 算法计算一个有理/非有理 B-Spline 点。 */
function evaluateDxfSplinePoint(
  controlPoints: CadReferencePoint2D[],
  degree: number,
  knots: number[],
  weights: number[] | undefined,
  parameter: number,
): CadReferencePoint2D | null {
  const lastControlPointIndex = controlPoints.length - 1;
  let span = lastControlPointIndex;
  if (parameter < knots[knots.length - degree - 1]) {
    span = degree;
    while (span < lastControlPointIndex && !(parameter >= knots[span] && parameter < knots[span + 1])) {
      span += 1;
    }
  }

  const values: Array<{ x: number; y: number; weight: number }> = [];
  for (let index = 0; index <= degree; index += 1) {
    const controlPointIndex = span - degree + index;
    const controlPoint = controlPoints[controlPointIndex];
    if (!controlPoint) return null;
    const weight = Math.max(Number.EPSILON, readFiniteNumber(weights?.[controlPointIndex], 1));
    values.push({ x: controlPoint.x * weight, y: controlPoint.y * weight, weight });
  }

  for (let level = 1; level <= degree; level += 1) {
    for (let index = degree; index >= level; index -= 1) {
      const knotIndex = span - degree + index;
      const denominator = knots[knotIndex + degree - level + 1] - knots[knotIndex];
      const alpha = denominator === 0 ? 0 : (parameter - knots[knotIndex]) / denominator;
      const previous = values[index - 1];
      const current = values[index];
      values[index] = {
        x: previous.x + (current.x - previous.x) * alpha,
        y: previous.y + (current.y - previous.y) * alpha,
        weight: previous.weight + (current.weight - previous.weight) * alpha,
      };
    }
  }

  const result = values[degree];
  if (!result || !Number.isFinite(result.weight) || Math.abs(result.weight) <= Number.EPSILON) return null;
  return { x: result.x / result.weight, y: result.y / result.weight };
}

/** 将 LWPOLYLINE/POLYLINE 转为折线，并支持 bulge 圆弧段。 */
function convertDxfPolylineToPolyline(entity: DxfPolylineEntityRecord, blockBasePoint: CadReferencePoint2D): CadReferencePoint2D[] {
  if (entity.polygonMesh || entity.polyfaceMesh || !Array.isArray(entity.vertices)) return [];

  const vertices = entity.vertices
    .filter(isRecord)
    .map((vertex) => readDxfVertex(vertex as DxfVertexRecord, blockBasePoint))
    .filter((vertex): vertex is CadReferencePoint2D & { bulge: number } => Boolean(vertex));

  if (vertices.length < 2) return [];

  const segmentVertices = entity.closed ? [...vertices, vertices[0]] : vertices;
  const points: CadReferencePoint2D[] = [];

  for (let index = 0; index < segmentVertices.length - 1; index += 1) {
    const from = segmentVertices[index];
    const to = segmentVertices[index + 1];
    points.push({ x: from.x, y: from.y });

    if (from.bulge) {
      points.push(...createBulgeArcPoints(from, to, from.bulge));
    }

    if (index === segmentVertices.length - 2) {
      points.push({ x: to.x, y: to.y });
    }
  }

  return applyEntityExtrusion(points, entity);
}

/** 根据 LWPOLYLINE bulge 值生成圆弧段中间采样点。 */
function createBulgeArcPoints(
  from: CadReferencePoint2D,
  to: CadReferencePoint2D,
  bulge: number,
): CadReferencePoint2D[] {
  if (!Number.isFinite(bulge) || Math.abs(bulge) < 1e-9) return [];

  let theta: number;
  let a: CadReferencePoint2D;
  let b: CadReferencePoint2D;

  if (bulge < 0) {
    theta = Math.atan(-bulge) * 4;
    a = from;
    b = to;
  } else {
    theta = Math.atan(bulge) * 4;
    a = to;
    b = from;
  }

  const ab = { x: b.x - a.x, y: b.y - a.y };
  const lengthAB = Math.hypot(ab.x, ab.y);
  if (lengthAB <= 0) return [];

  const midpoint = { x: a.x + ab.x * 0.5, y: a.y + ab.y * 0.5 };
  const lengthCD = Math.abs(lengthAB / 2 / Math.tan(theta / 2));
  const normAB = { x: ab.x / lengthAB, y: ab.y / lengthAB };
  const normal = { x: -normAB.y, y: normAB.x };
  const center = theta < Math.PI
    ? { x: midpoint.x - normal.x * lengthCD, y: midpoint.y - normal.y * lengthCD }
    : { x: midpoint.x + normal.x * lengthCD, y: midpoint.y + normal.y * lengthCD };
  const startAngle = Math.atan2(b.y - center.y, b.x - center.x);
  let endAngle = Math.atan2(a.y - center.y, a.x - center.x);
  while (endAngle < startAngle) {
    endAngle += Math.PI * 2;
  }

  const radius = Math.hypot(b.x - center.x, b.y - center.y);
  const startIndex = Math.floor(startAngle / CAD_REFERENCE_ARC_SEGMENT_RADIANS) + 1;
  const endIndex = Math.ceil(endAngle / CAD_REFERENCE_ARC_SEGMENT_RADIANS) - 1;
  const points: CadReferencePoint2D[] = [];

  for (let index = startIndex; index <= endIndex; index += 1) {
    const angle = index * CAD_REFERENCE_ARC_SEGMENT_RADIANS;
    points.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  }

  return bulge < 0 ? points.reverse() : points;
}

/** 读取普通点对象并按当前块基点归一到局部坐标。 */
function readPoint2D(value: unknown, blockBasePoint: CadReferencePoint2D): CadReferencePoint2D | null {
  if (!isRecord(value)) return null;

  const x = readFiniteNumber(value.x, Number.NaN);
  const y = readFiniteNumber(value.y, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  return {
    x: x - blockBasePoint.x,
    y: y - blockBasePoint.y,
  };
}

/** 读取带 x/y/r 的实体中心点。 */
function readPositionalCenter(entity: DxfPositionalEntityRecord, blockBasePoint: CadReferencePoint2D): CadReferencePoint2D | null {
  const x = readFiniteNumber(entity.x, Number.NaN);
  const y = readFiniteNumber(entity.y, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  return {
    x: x - blockBasePoint.x,
    y: y - blockBasePoint.y,
  };
}

/** 读取多段线顶点，并保留当前顶点的 bulge 圆弧参数。 */
function readDxfVertex(vertex: DxfVertexRecord, blockBasePoint: CadReferencePoint2D): (CadReferencePoint2D & { bulge: number }) | null {
  const x = readFiniteNumber(vertex.x, Number.NaN);
  const y = readFiniteNumber(vertex.y, Number.NaN);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

  return {
    x: x - blockBasePoint.x,
    y: y - blockBasePoint.y,
    bulge: readFiniteNumber(vertex.bulge, 0),
  };
}

/** 应用实体自身反向 extrusion，避免镜像圆弧和块内镜像丢失。 */
function applyEntityExtrusion(points: CadReferencePoint2D[], entity: DxfEntityRecord): CadReferencePoint2D[] {
  if (readOptionalFiniteNumber(entity.extrusionZ) !== -1) {
    return points.filter(isFinitePoint2D);
  }

  return points
    .map((point) => ({ x: -point.x, y: point.y }))
    .filter(isFinitePoint2D);
}

/** 将块 INSERT 累积 Transform 应用到折线点。 */
function transformCadPolyline(points: CadReferencePoint2D[], transforms: DxfTransform[]): CadReferencePoint2D[] {
  return points
    .map((point) => transformCadPoint(point, transforms))
    .filter(isFinitePoint2D);
}

/** 将单个点依次应用从内到外的 INSERT Transform。 */
function transformCadPoint(point: CadReferencePoint2D, transforms: DxfTransform[]): CadReferencePoint2D {
  let x = point.x;
  let y = point.y;

  for (const transform of transforms) {
    x *= readFiniteNumber(transform.scaleX, 1);
    y *= readFiniteNumber(transform.scaleY, 1);

    const rotation = readFiniteNumber(transform.rotation, 0);
    if (rotation) {
      const angle = (rotation / 180) * Math.PI;
      const nextX = x * Math.cos(angle) - y * Math.sin(angle);
      const nextY = y * Math.cos(angle) + x * Math.sin(angle);
      x = nextX;
      y = nextY;
    }

    x += readFiniteNumber(transform.x, 0);
    y += readFiniteNumber(transform.y, 0);

    if (readOptionalFiniteNumber(transform.extrusionZ) === -1) {
      x = -x;
    }
  }

  return { x, y };
}

/** 根据原始二维包围盒创建与 DXF 同向的 Babylon 米制地面包围盒。 */
function createCadReferenceBounds(bounds: Bounds2D, unitScaleToMeters: number): CadReferenceBounds {
  const halfSizeX = ((bounds.maxX - bounds.minX) * unitScaleToMeters) / 2;
  const halfSizeZ = ((bounds.maxY - bounds.minY) * unitScaleToMeters) / 2;
  return {
    min: { x: -halfSizeX, y: CAD_REFERENCE_GRID_Y_OFFSET_METERS, z: -halfSizeZ },
    max: { x: halfSizeX, y: CAD_REFERENCE_GRID_Y_OFFSET_METERS, z: halfSizeZ },
    size: { x: halfSizeX * 2, y: 0, z: halfSizeZ * 2 },
    center: { x: 0, y: CAD_REFERENCE_GRID_Y_OFFSET_METERS, z: 0 },
  };
}

/** 判断二维点是否可安全传给 Babylon LineSystem。 */
function isFinitePoint2D(point: CadReferencePoint2D): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
    && Math.abs(point.x) <= CAD_REFERENCE_MAX_ABSOLUTE_COORDINATE
    && Math.abs(point.y) <= CAD_REFERENCE_MAX_ABSOLUTE_COORDINATE;
}

/** 扩展原始 DXF 二维包围盒。 */
function expandBounds2D(bounds: Bounds2D | null, point: CadReferencePoint2D): Bounds2D {
  if (!bounds) {
    return {
      minX: point.x,
      minY: point.y,
      maxX: point.x,
      maxY: point.y,
    };
  }

  return {
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  };
}

/** 判断未知值是否为可安全读取的普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 读取有限数字，非法值使用调用方指定的默认值。 */
function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 读取可选有限数字，非法值保持 undefined。 */
function readOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 读取正整数数量，避免 INSERT 阵列的非法计数破坏遍历。 */
function readPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

/** 从未知错误中提取简短可读信息。 */
function readErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

/** 判断字符串是否为 6 位十六进制颜色。 */
function isColorLike(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

/** 归一化透明度输入，非法值回退到当前值。 */
function clampOpacity(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}
