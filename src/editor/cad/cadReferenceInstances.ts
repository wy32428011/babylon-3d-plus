import type { Block as DxfBlock, Entity as DxfEntity, ParsedDXF } from '@linkiez/dxf-renew';
import type { CadReferenceBounds, CadReferenceLayerStat } from '../model/components';
import {
  CAD_REFERENCE_GRID_Y_OFFSET_METERS,
  CAD_REFERENCE_MAX_ABSOLUTE_COORDINATE,
  CAD_REFERENCE_MAX_INSERT_ARRAY_INSTANCES,
  CAD_REFERENCE_MAX_INSERT_DEPTH,
  convertDxfEntityToPolylines,
  isSupportedDxfEntity,
  readDxfEntityLayerName,
  type CadReferenceGeometryBudget,
  type CadReferenceGeometryLayer,
  type CadReferenceParseOptions,
  type CadReferenceParseResult,
  type CadReferencePoint2D,
  type DxfEntityRecord,
  type DxfInsertEntityRecord,
} from './cadReference';
import { createLegacyCadReferenceUnitInfo, resolveDxfUnitInfo } from './cadUnits';

type Affine2D = readonly [a: number, b: number, c: number, d: number, tx: number, ty: number];

type Bounds2D = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type RawGeometry = {
  nativeLayerName: string;
  coordinates: number[];
  polylinePointCounts: number[];
  entityCount: number;
  polylineCount: number;
  pointCount: number;
  bounds: Bounds2D | null;
};

type PrototypeUse = {
  prototype: RawGeometry;
  displayLayerName: string;
  transforms: Affine2D[];
};

type TraversalState = {
  entities: DxfEntityRecord[];
  parentBasePoint: CadReferencePoint2D;
  transform: Affine2D;
  layerOverride: string | null;
  depth: number;
  blockPath: string[];
};

const IDENTITY_AFFINE: Affine2D = [1, 0, 0, 1, 0, 0];

/**
 * 将已扫描的 DXF 转成普通顶层线稿与 BLOCK 原型实例。
 * 几何预算只约束唯一原型，重复 INSERT 仅增加矩阵和逻辑统计。
 */
export function convertParsedCadReferenceDxfInstanced(
  parsed: ParsedDXF,
  options: CadReferenceParseOptions = {},
): CadReferenceParseResult {
  const detectedUnitInfo = resolveDxfUnitInfo(parsed.header);
  const unitInfo = options.unitScaleToMeters === undefined || options.unitScaleToMeters === detectedUnitInfo.unitScaleToMeters
    ? detectedUnitInfo
    : createLegacyCadReferenceUnitInfo(options.unitScaleToMeters);
  const budget = normalizeBudget(options.geometryBudget);
  const blocksByName = createBlocksByName(parsed.blocks);
  const rootGeometries = collectDirectGeometry(
    normalizeEntities(parsed.entities).filter((entity) => entity.type !== 'INSERT'),
    { x: 0, y: 0 },
  );
  const prototypesByBlock = collectBlockPrototypes(blocksByName);
  enforceSourceBudget([...rootGeometries, ...[...prototypesByBlock.values()].flat()], budget);
  const uses = collectPrototypeUses(parsed, blocksByName, prototypesByBlock);
  const drawingBounds = calculateDrawingBounds(rootGeometries, uses);
  const center = {
    x: (drawingBounds.minX + drawingBounds.maxX) / 2,
    y: (drawingBounds.minY + drawingBounds.maxY) / 2,
  };
  const layers = [
    ...rootGeometries.map((geometry) => packRootGeometry(geometry, center, unitInfo.unitScaleToMeters)),
    ...uses.map((use) => packInstancedGeometry(use, center, unitInfo.unitScaleToMeters)),
  ];
  const { layerStats, polylineCount, pointCount } = summarizeLayers(layers);

  return {
    sourceUnitCode: unitInfo.sourceUnitCode,
    sourceUnitName: unitInfo.sourceUnitName,
    unitDetection: unitInfo.unitDetection,
    unitScaleToMeters: unitInfo.unitScaleToMeters,
    layerStats,
    bounds: createBounds(drawingBounds, unitInfo.unitScaleToMeters),
    polylineCount,
    pointCount,
    layers,
    budgetLimited: false,
  };
}

function collectBlockPrototypes(blocksByName: Map<string, DxfBlock>): Map<string, RawGeometry[]> {
  const result = new Map<string, RawGeometry[]>();
  for (const [blockName, block] of blocksByName) {
    result.set(blockName, collectDirectGeometry(
      normalizeEntities(block.entities).filter((entity) => entity.type !== 'INSERT'),
      { x: readNumber(block.x, 0), y: readNumber(block.y, 0) },
      true,
    ));
  }
  return result;
}

function collectPrototypeUses(
  parsed: ParsedDXF,
  blocksByName: Map<string, DxfBlock>,
  prototypesByBlock: Map<string, RawGeometry[]>,
): PrototypeUse[] {
  const usesByPrototype = new Map<RawGeometry, Map<string, PrototypeUse>>();
  const stack: TraversalState[] = [{
    entities: normalizeEntities(parsed.entities),
    parentBasePoint: { x: 0, y: 0 },
    transform: IDENTITY_AFFINE,
    layerOverride: null,
    depth: 0,
    blockPath: [],
  }];

  while (stack.length > 0) {
    const state = stack.pop();
    if (!state) continue;
    for (const entity of state.entities) {
      if (entity.type !== 'INSERT') continue;
      const insert = entity as DxfInsertEntityRecord;
      const blockName = typeof insert.block === 'string' ? insert.block : '';
      const block = blocksByName.get(blockName);
      if (!block || state.depth >= CAD_REFERENCE_MAX_INSERT_DEPTH || state.blockPath.includes(blockName)) continue;

      const localTransforms = createInsertArrayTransforms(insert, state.parentBasePoint);
      const displayLayerName = state.layerOverride ?? readDxfEntityLayerName(insert);
      for (let index = localTransforms.length - 1; index >= 0; index -= 1) {
        const combinedTransform = multiplyAffine(state.transform, localTransforms[index]);
        for (const prototype of prototypesByBlock.get(blockName) ?? []) {
          const usesByLayer = usesByPrototype.get(prototype) ?? new Map<string, PrototypeUse>();
          const use = usesByLayer.get(displayLayerName) ?? { prototype, displayLayerName, transforms: [] };
          use.transforms.push(combinedTransform);
          usesByLayer.set(displayLayerName, use);
          usesByPrototype.set(prototype, usesByLayer);
        }

        stack.push({
          entities: normalizeEntities(block.entities),
          parentBasePoint: { x: readNumber(block.x, 0), y: readNumber(block.y, 0) },
          transform: combinedTransform,
          layerOverride: displayLayerName,
          depth: state.depth + 1,
          blockPath: [...state.blockPath, blockName],
        });
      }
    }
  }
  return [...usesByPrototype.values()].flatMap((usesByLayer) => [...usesByLayer.values()]);
}

function calculateDrawingBounds(rootGeometries: RawGeometry[], uses: PrototypeUse[]): Bounds2D {
  let drawingBounds: Bounds2D | null = null;
  for (const geometry of rootGeometries) drawingBounds = mergeBounds(drawingBounds, geometry.bounds);
  for (const use of uses) {
    for (const transform of use.transforms) {
      drawingBounds = mergeBounds(drawingBounds, transformBounds(use.prototype.bounds, transform));
    }
  }
  if (!drawingBounds) throw new Error('DXF 中没有可显示的线稿图元。');
  return drawingBounds;
}

function summarizeLayers(layers: CadReferenceGeometryLayer[]): {
  layerStats: CadReferenceLayerStat[];
  polylineCount: number;
  pointCount: number;
} {
  const statsByLayer = new Map<string, CadReferenceLayerStat>();
  let polylineCount = 0;
  let pointCount = 0;
  for (const layer of layers) {
    polylineCount += layer.polylineCount;
    pointCount += layer.pointCount;
    const stat = statsByLayer.get(layer.name) ?? { name: layer.name, entityCount: 0, polylineCount: 0, pointCount: 0 };
    stat.entityCount += layer.entityCount;
    stat.polylineCount += layer.polylineCount;
    stat.pointCount += layer.pointCount;
    statsByLayer.set(layer.name, stat);
  }

  return { layerStats: [...statsByLayer.values()], polylineCount, pointCount };
}

function collectDirectGeometry(
  entities: DxfEntityRecord[],
  basePoint: CadReferencePoint2D,
  mergeLayers = false,
): RawGeometry[] {
  const layers = new Map<string, RawGeometry>();
  for (const entity of entities) {
    if (!isSupportedDxfEntity(entity)) continue;
    // INSERT 的既有语义会把整个块归入最外层 INSERT 图层；提前合并可显著减少 LinesMesh 数量。
    const layerName = mergeLayers ? '__BLOCK__' : readDxfEntityLayerName(entity);
    const geometry = layers.get(layerName) ?? {
      nativeLayerName: layerName,
      coordinates: [],
      polylinePointCounts: [],
      entityCount: 0,
      polylineCount: 0,
      pointCount: 0,
      bounds: null,
    };
    let contributed = false;
    for (const points of convertDxfEntityToPolylines(entity, basePoint)) {
      const finitePoints = points.filter(isFinitePoint);
      if (finitePoints.length < 2) continue;
      geometry.polylinePointCounts.push(finitePoints.length);
      geometry.polylineCount += 1;
      geometry.pointCount += finitePoints.length;
      contributed = true;
      for (const point of finitePoints) {
        geometry.coordinates.push(point.x, point.y);
        geometry.bounds = expandBounds(geometry.bounds, point);
      }
    }
    if (contributed) geometry.entityCount += 1;
    layers.set(layerName, geometry);
  }
  return [...layers.values()].filter((geometry) => geometry.pointCount > 0);
}

function createInsertArrayTransforms(insert: DxfInsertEntityRecord, parentBasePoint: CadReferencePoint2D): Affine2D[] {
  const rowCount = readPositiveInteger(insert.rowCount, 1);
  const columnCount = readPositiveInteger(insert.columnCount, 1);
  const totalCount = rowCount * columnCount;
  if (totalCount > CAD_REFERENCE_MAX_INSERT_ARRAY_INSTANCES) {
    throw new Error(`INSERT 阵列包含 ${totalCount} 个实例，超过单阵列安全上限 ${CAD_REFERENCE_MAX_INSERT_ARRAY_INSTANCES}。`);
  }

  const rotation = (readNumber(insert.rotation, 0) / 180) * Math.PI;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const rowSpacing = readNumber(insert.rowSpacing, 0);
  const columnSpacing = readNumber(insert.columnSpacing, 0);
  const transforms: Affine2D[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      const rowX = -sin * rowSpacing * row;
      const rowY = cos * rowSpacing * row;
      const columnX = cos * columnSpacing * column;
      const columnY = sin * columnSpacing * column;
      let transform: Affine2D = [
        cos * readNumber(insert.scaleX, 1),
        sin * readNumber(insert.scaleX, 1),
        -sin * readNumber(insert.scaleY, 1),
        cos * readNumber(insert.scaleY, 1),
        readNumber(insert.x, 0) - parentBasePoint.x + rowX + columnX,
        readNumber(insert.y, 0) - parentBasePoint.y + rowY + columnY,
      ];
      if (readNumber(insert.extrusionZ, 1) === -1) {
        transform = [-transform[0], transform[1], -transform[2], transform[3], -transform[4], transform[5]];
      }
      transforms.push(transform);
    }
  }
  return transforms;
}

function multiplyAffine(parent: Affine2D, child: Affine2D): Affine2D {
  return [
    parent[0] * child[0] + parent[2] * child[1],
    parent[1] * child[0] + parent[3] * child[1],
    parent[0] * child[2] + parent[2] * child[3],
    parent[1] * child[2] + parent[3] * child[3],
    parent[0] * child[4] + parent[2] * child[5] + parent[4],
    parent[1] * child[4] + parent[3] * child[5] + parent[5],
  ];
}

function packRootGeometry(geometry: RawGeometry, center: CadReferencePoint2D, scale: number): CadReferenceGeometryLayer {
  const positions = new Float32Array(geometry.pointCount * 3);
  for (let index = 0; index < geometry.pointCount; index += 1) {
    positions[index * 3] = (geometry.coordinates[index * 2] - center.x) * scale;
    positions[index * 3 + 1] = CAD_REFERENCE_GRID_Y_OFFSET_METERS;
    positions[index * 3 + 2] = (geometry.coordinates[index * 2 + 1] - center.y) * scale;
  }
  return {
    name: geometry.nativeLayerName,
    positions,
    polylinePointCounts: Uint32Array.from(geometry.polylinePointCounts),
    entityCount: geometry.entityCount,
    polylineCount: geometry.polylineCount,
    pointCount: geometry.pointCount,
  };
}

function packInstancedGeometry(use: PrototypeUse, center: CadReferencePoint2D, scale: number): CadReferenceGeometryLayer {
  const positions = new Float32Array(use.prototype.pointCount * 3);
  for (let index = 0; index < use.prototype.pointCount; index += 1) {
    positions[index * 3] = use.prototype.coordinates[index * 2] * scale;
    positions[index * 3 + 2] = use.prototype.coordinates[index * 2 + 1] * scale;
  }
  const instanceMatrices = new Float32Array(use.transforms.length * 16);
  use.transforms.forEach((transform, index) => {
    instanceMatrices.set([
      transform[0], 0, transform[1], 0,
      0, 1, 0, 0,
      transform[2], 0, transform[3], 0,
      (transform[4] - center.x) * scale,
      CAD_REFERENCE_GRID_Y_OFFSET_METERS,
      (transform[5] - center.y) * scale,
      1,
    ], index * 16);
  });
  const instanceCount = use.transforms.length;
  return {
    name: use.displayLayerName,
    positions,
    polylinePointCounts: Uint32Array.from(use.prototype.polylinePointCounts),
    instanceMatrices,
    instanceCount,
    entityCount: use.prototype.entityCount * instanceCount,
    polylineCount: use.prototype.polylineCount * instanceCount,
    pointCount: use.prototype.pointCount * instanceCount,
  };
}

function createBlocksByName(blocks: DxfBlock[] | undefined): Map<string, DxfBlock> {
  const result = new Map<string, DxfBlock>();
  for (const block of blocks ?? []) {
    if (typeof block.name === 'string' && block.name) result.set(block.name, block);
  }
  return result;
}

function normalizeEntities(entities: DxfEntity[] | undefined): DxfEntityRecord[] {
  return (entities ?? []).filter((entity): entity is DxfEntityRecord => typeof entity === 'object' && entity !== null);
}

function normalizeBudget(budget: CadReferenceGeometryBudget | undefined): CadReferenceGeometryBudget | null {
  if (!budget) return null;
  return {
    maxPolylines: Math.max(1, Math.floor(readNumber(budget.maxPolylines, 1))),
    maxPoints: Math.max(2, Math.floor(readNumber(budget.maxPoints, 2))),
  };
}

function enforceSourceBudget(geometries: RawGeometry[], budget: CadReferenceGeometryBudget | null): void {
  if (!budget) return;
  const polylineCount = geometries.reduce((sum, geometry) => sum + geometry.polylineCount, 0);
  const pointCount = geometries.reduce((sum, geometry) => sum + geometry.pointCount, 0);
  if (polylineCount > budget.maxPolylines || pointCount > budget.maxPoints) {
    throw new Error(`CAD 唯一原型几何超过安全上限：${polylineCount} 条折线 / ${pointCount} 个点。`);
  }
}

function transformBounds(bounds: Bounds2D | null, transform: Affine2D): Bounds2D | null {
  if (!bounds) return null;
  let transformed: Bounds2D | null = null;
  for (const point of [
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.minX, y: bounds.maxY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
  ]) {
    transformed = expandBounds(transformed, {
      x: transform[0] * point.x + transform[2] * point.y + transform[4],
      y: transform[1] * point.x + transform[3] * point.y + transform[5],
    });
  }
  return transformed;
}

function expandBounds(bounds: Bounds2D | null, point: CadReferencePoint2D): Bounds2D {
  if (!bounds) return { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y };
  return {
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  };
}

function mergeBounds(left: Bounds2D | null, right: Bounds2D | null): Bounds2D | null {
  if (!left) return right;
  if (!right) return left;
  return {
    minX: Math.min(left.minX, right.minX),
    minY: Math.min(left.minY, right.minY),
    maxX: Math.max(left.maxX, right.maxX),
    maxY: Math.max(left.maxY, right.maxY),
  };
}

function createBounds(bounds: Bounds2D, scale: number): CadReferenceBounds {
  const halfX = ((bounds.maxX - bounds.minX) * scale) / 2;
  const halfZ = ((bounds.maxY - bounds.minY) * scale) / 2;
  return {
    min: { x: -halfX, y: CAD_REFERENCE_GRID_Y_OFFSET_METERS, z: -halfZ },
    max: { x: halfX, y: CAD_REFERENCE_GRID_Y_OFFSET_METERS, z: halfZ },
    size: { x: halfX * 2, y: 0, z: halfZ * 2 },
    center: { x: 0, y: CAD_REFERENCE_GRID_Y_OFFSET_METERS, z: 0 },
  };
}

function isFinitePoint(point: CadReferencePoint2D): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y)
    && Math.abs(point.x) <= CAD_REFERENCE_MAX_ABSOLUTE_COORDINATE
    && Math.abs(point.y) <= CAD_REFERENCE_MAX_ABSOLUTE_COORDINATE;
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readPositiveInteger(value: unknown, fallback: number): number {
  return Math.max(1, Math.floor(readNumber(value, fallback)));
}
