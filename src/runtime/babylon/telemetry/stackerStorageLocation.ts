import { Vector3, type TransformNode } from '@babylonjs/core';
import { transformWorldBounds, type RuntimeWorldBounds } from '../runtimeNodeGeometry';

export type StackerStorageTargetOffsetInput = {
  targetTravelCoordinate: number;
  targetLiftCoordinate: number;
  referenceTravelCoordinate: number;
  referenceLiftCoordinate: number;
};

export type StackerStorageTargetOffsets = {
  travelOffset: number;
  liftOffset: number;
};

/**
 * 把库位世界坐标换算为相对 Stacker 货叉初始锚点的行走与升降偏移。
 * 库位是绝对世界位置，不能直接当作从模型根节点开始的位移量。
 */
export function resolveStackerStorageTargetOffsets(
  input: StackerStorageTargetOffsetInput,
): StackerStorageTargetOffsets {
  const targetTravel = Number.isFinite(input.targetTravelCoordinate) ? input.targetTravelCoordinate : 0;
  const targetLift = Number.isFinite(input.targetLiftCoordinate) ? input.targetLiftCoordinate : 0;
  const referenceTravel = Number.isFinite(input.referenceTravelCoordinate) ? input.referenceTravelCoordinate : 0;
  const referenceLift = Number.isFinite(input.referenceLiftCoordinate) ? input.referenceLiftCoordinate : 0;
  return {
    travelOffset: targetTravel - referenceTravel,
    liftOffset: Math.max(0, targetLift - referenceLift),
  };
}

export type LocatorBoxIndexInput = {
  startColumn: number;
  startLayer: number;
  columns: number;
  layers: number;
  /** 列反向：true 时大数列映射到靠近原点的几何索引 0。 */
  columnReversed: boolean;
  toX: number;
  toY: number;
};

/** 把 MQTT 目标列/层换算为 Locator boxes 数组下标；越界返回 null，调用方回退 locator 根节点。 */
export function resolveLocatorBoxIndex(input: LocatorBoxIndexInput): number | null {
  const rawColumnIndex = input.toX - input.startColumn;
  const layerIndex = input.toY - input.startLayer;
  if (rawColumnIndex < 0 || rawColumnIndex >= input.columns) return null;
  if (layerIndex < 0 || layerIndex >= input.layers) return null;
  const columnIndex = input.columnReversed ? input.columns - 1 - rawColumnIndex : rawColumnIndex;
  return layerIndex * input.columns + columnIndex;
}

export type LocatorCellCoordinate = {
  row: number;
  column: number;
  layer: number;
};

export type LocatorCellLocalBounds = {
  columnIndex: number;
  layerIndex: number;
  boxIndex: number;
  center: { x: number; y: number; z: number };
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
};

/** 解析货格支撑位所需的最小运行时结构，避免反向依赖 SceneRuntime 的 LocatorRuntimeEntry。 */
export type LocatorCellGridShape = {
  columns: number;
  layers: number;
  /** 构建渲染网格时实际使用的步距（含绑定期货架脚本写入的实测步距）。 */
  cellSteps: { columnStepX: number; layerStepY: number };
  root: TransformNode;
};

export type LocatorCellGridGeometry = LocatorCellGridShape & {
  startColumn: number;
  startLayer: number;
  rowNumber: number;
  /** 列反向：true 时大数列映射到靠近原点的几何索引 0。 */
  columnReversed: boolean;
  /** 单格尺寸（米）：length=列向，height=层向，width=进深。 */
  cellSize: { length: number; height: number; width: number };
};

/** 把业务坐标「排-列-层」换算为 boxes 数组下标；排不匹配或列/层越界返回 null。 */
export function resolveLocatorCellLocalIndex(
  locator: Pick<LocatorCellGridGeometry, 'startColumn' | 'startLayer' | 'rowNumber' | 'columns' | 'layers' | 'columnReversed'>,
  coordinate: LocatorCellCoordinate,
): number | null {
  if (locator.rowNumber !== coordinate.row) return null;
  return resolveLocatorBoxIndex({
    startColumn: locator.startColumn,
    startLayer: locator.startLayer,
    columns: locator.columns,
    layers: locator.layers,
    columnReversed: locator.columnReversed,
    toX: coordinate.column,
    toY: coordinate.layer,
  });
}

/**
 * 按构建步距解析单格本地 AABB。
 * 格子本地底面中心 = (列 × 列步距, 层 × 层步距, 0)，体中心 y = height/2 + 层步距。
 * columnStepX 为负时仍取角点 min/max，保证 AABB 合法。
 */
export function resolveLocatorCellLocalBounds(
  locator: Pick<LocatorCellGridGeometry, 'columns' | 'layers' | 'cellSteps' | 'cellSize'>,
  boxIndex: number,
): LocatorCellLocalBounds | null {
  if (!Number.isInteger(boxIndex) || boxIndex < 0 || boxIndex >= locator.columns * locator.layers) return null;
  const columnIndex = boxIndex % locator.columns;
  const layerIndex = Math.floor(boxIndex / locator.columns);
  const { length, height, width } = locator.cellSize;
  const centerX = columnIndex * locator.cellSteps.columnStepX;
  const minY = layerIndex * locator.cellSteps.layerStepY;
  const centerY = height / 2 + minY;
  const x0 = centerX - length / 2;
  const x1 = centerX + length / 2;
  return {
    columnIndex,
    layerIndex,
    boxIndex,
    center: { x: centerX, y: centerY, z: 0 },
    min: { x: Math.min(x0, x1), y: minY, z: -width / 2 },
    max: { x: Math.max(x0, x1), y: minY + height, z: width / 2 },
    size: { x: length, y: height, z: width },
  };
}

/**
 * 按构建步距解析货格底面中心的世界坐标（货叉/货物支撑位）。
 * 格子本地底面中心 = (列 × 列步距, 层 × 层步距, 0)，与渲染网格的生成公式严格一致。
 */
export function resolveLocatorCellSupportWorldPosition(locator: LocatorCellGridShape, boxIndex: number): Vector3 | null {
  if (!Number.isInteger(boxIndex) || boxIndex < 0 || boxIndex >= locator.columns * locator.layers) return null;
  const columnIndex = boxIndex % locator.columns;
  const layerIndex = Math.floor(boxIndex / locator.columns);
  locator.root.computeWorldMatrix(true);
  return Vector3.TransformCoordinates(
    new Vector3(columnIndex * locator.cellSteps.columnStepX, layerIndex * locator.cellSteps.layerStepY, 0),
    locator.root.getWorldMatrix(),
  );
}

/** 把单格本地 AABB 经 8 角点变换为世界 AABB，供相机聚焦使用。 */
export function resolveLocatorCellWorldBounds(
  locator: LocatorCellGridGeometry,
  coordinate: LocatorCellCoordinate,
): RuntimeWorldBounds | null {
  const boxIndex = resolveLocatorCellLocalIndex(locator, coordinate);
  if (boxIndex === null) return null;
  const local = resolveLocatorCellLocalBounds(locator, boxIndex);
  if (!local) return null;
  locator.root.computeWorldMatrix(true);
  return transformWorldBounds(
    {
      minimum: new Vector3(local.min.x, local.min.y, local.min.z),
      maximum: new Vector3(local.max.x, local.max.y, local.max.z),
    },
    locator.root.getWorldMatrix(),
  );
}
