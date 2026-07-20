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
