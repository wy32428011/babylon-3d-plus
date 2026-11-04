import type { CargoHost, DeepReadonly, DeviceIdentity, Matrix4, PoseSample, StateReadView } from '../../history/state';

/** canonical 数值投影；不是 Mesh，也不会调用旧实时生成器或业务脚本。 */
export type HistorySceneFrame = {
  projectionId: string; revision: string; sampledAt: number;
  devices: { id: string; identity: DeepReadonly<DeviceIdentity>; logicalDeviceId: string | null; modelId: string; dynamicGeneratorId: string | null; dynamicGeneration: string | null; worldMatrix: DeepReadonly<Matrix4>;
    anchors: readonly { id: string; worldMatrix: DeepReadonly<Matrix4> }[] }[];
  cargo: { id: string; generatorId: string | null; host: DeepReadonly<CargoHost>; worldMatrix: DeepReadonly<Matrix4> }[];
  slots: { id: string; locatorId: string; row: string; column: number; layer: number; depth: string; cargoId: string | null }[];
  alarms: { id: string; deviceId: string; ruleId: string; active: boolean; activatedAt: number | null }[];
};

/**
 * 仅为真实 Babylon 适配器准备经过内核验证的显示输入。
 * 不负责决定模型资源、建 Mesh、触发通知或更新事实；任何实体无法映射都必须由宿主阻断提交。
 */
export function buildHistorySceneFrame(view: StateReadView, pose: DeepReadonly<PoseSample>): HistorySceneFrame {
  if (pose.projectionId !== view.metadata.projectionId || pose.stateRevision !== view.metadata.cursor.stateRevision) {
    throw new Error('历史位姿与状态游标不匹配，不能提交画面。');
  }
  const deviceIds = new Set([...view.values('devices')].map(device => device.id));
  const cargoIds = new Set([...view.values('cargo')].filter(item => item.destroyedAt === null).map(item => item.id));
  if (pose.devices.length !== deviceIds.size || pose.cargo.length !== cargoIds.size
    || new Set(pose.devices.map(item => item.id)).size !== deviceIds.size
    || new Set(pose.cargo.map(item => item.id)).size !== cargoIds.size
    || pose.devices.some(item => !deviceIds.has(item.id)) || pose.cargo.some(item => !cargoIds.has(item.id))) {
    throw new Error('历史位姿没有覆盖全部活动设备或货物，不能提交不完整画面。');
  }
  const models = new Map(view.logic.models.map(model => [model.id, model]));
  const devices = pose.devices.map(sample => {
    const device = view.get('devices', sample.id);
    if (!device) throw new Error('历史设备位姿没有对应状态，不能提交画面。');
    const model = models.get(device.modelId);
    const anchors = new Set(sample.anchors.map(anchor => anchor.id));
    if (!model || anchors.size !== model.anchors.length || sample.anchors.length !== anchors.size
      || model.anchors.some(anchor => !anchors.has(anchor.id))) throw new Error('历史设备部件锚点不完整，不能提交画面。');
    return { id: device.id, identity: device.identity, logicalDeviceId: device.logicalDeviceId, modelId: device.modelId,
      dynamicGeneratorId: device.dynamic?.generatorId ?? null, dynamicGeneration: device.dynamic?.generation ?? null,
      worldMatrix: sample.worldMatrix, anchors: sample.anchors };
  });
  const cargo = pose.cargo.map(sample => {
    const item = view.get('cargo', sample.id);
    if (!item || !item.host || item.destroyedAt !== null) throw new Error('历史货物缺少唯一活动宿主，不能提交画面。');
    return { id: item.id, generatorId: item.origin.generatorId, host: item.host, worldMatrix: sample.worldMatrix };
  });
  const slotsById = new Map(view.logic.slots.map(slot => [slot.id, slot]));
  const slots = [...view.values('slots')].map(slot => {
    const logical = slotsById.get(slot.id);
    if (!logical) throw new Error('历史库位缺少同版本逻辑映射，不能提交画面。');
    return { id: slot.id, locatorId: logical.locatorId, row: logical.row, column: logical.column, layer: logical.layer, depth: logical.depth, cargoId: slot.cargoId };
  });
  const alarms = [...view.values('alarms')].map(alarm => ({ id: alarm.id, deviceId: alarm.deviceId, ruleId: alarm.ruleId,
    active: alarm.active, activatedAt: alarm.activatedAt }));
  return { projectionId: pose.projectionId, revision: pose.stateRevision, sampledAt: pose.sampledAt, devices, cargo, slots, alarms };
}
