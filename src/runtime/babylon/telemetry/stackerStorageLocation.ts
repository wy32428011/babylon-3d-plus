import { Vector3, type TransformNode } from '@babylonjs/core';

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

/** 解析货格支撑位所需的最小运行时结构，避免反向依赖 SceneRuntime 的 LocatorRuntimeEntry。 */
export type LocatorCellGridShape = {
  columns: number;
  layers: number;
  /** 构建渲染网格时实际使用的步距（含绑定期货架脚本写入的实测步距）。 */
  cellSteps: { columnStepX: number; layerStepY: number };
  root: TransformNode;
};

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
