import type { LocatorStorageDepth } from '../../../editor/model/components';

/**
 * 根据库位排深返回货叉允许的总行程。
 * 近排只允许第一段，远排允许第一段与第二段；非法行程统一按 0 防御。
 */
export function resolveStackerStorageForkReach(
  storageDepth: LocatorStorageDepth,
  stageOneReach: number,
  stageTwoReach: number,
): number {
  const stageOne = Number.isFinite(stageOneReach) ? Math.max(0, stageOneReach) : 0;
  const stageTwo = Number.isFinite(stageTwoReach) ? Math.max(0, stageTwoReach) : 0;
  return storageDepth === 'far' ? stageOne + stageTwo : stageOne;
}

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
  columns: number;
  layers: number;
  toX: number;
  toY: number;
};

/** 把 MQTT 目标列/层换算为 Locator boxes 数组下标；越界返回 null，调用方回退 locator 根节点。 */
export function resolveLocatorBoxIndex(input: LocatorBoxIndexInput): number | null {
  const columnIndex = input.toX - input.startColumn;
  const layerIndex = input.toY - 1;
  if (columnIndex < 0 || columnIndex >= input.columns) return null;
  if (layerIndex < 0 || layerIndex >= input.layers) return null;
  return layerIndex * input.columns + columnIndex;
}
