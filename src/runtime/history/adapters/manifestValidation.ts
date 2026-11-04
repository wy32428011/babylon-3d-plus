import type { DeepReadonly, JsonObject, LogicManifest, StateReadView } from '../state/types';
import { canonicalStringify, copySafeJson, DEFAULT_STATE_BUDGETS, freezeData, requireState, stableKey, compareDecimal } from '../state/safeJson';
import { validateJsonSchema } from '../state/schema';
import { assertPose } from '../state/validation';
import { compareInputCursor, deviceIdentityKey, dynamicDeviceId, fetchRowId } from '../state/identity';
import type { LogisticsDeviceSpec, LogisticsManifest } from './manifest';
import { LOGISTICS_ADAPTER_ID, LOGISTICS_ADAPTER_VERSION, LOGISTICS_MANIFEST_KEY, LOGISTICS_STATE_SCHEMA_VERSION } from './manifest';
import { LOGISTICS_MANIFEST_SCHEMA } from './schemas';
import { getLogisticsClockSpecs } from './scheduler';
import type { LogisticsAdapterValue, LogisticsDriverState, CargoRuntimeState, RawTelemetryState } from './runtimeState';
import { assertLogisticsRawTelemetry } from './lifecycle';

const cache = new WeakMap<object, DeepReadonly<LogisticsManifest>>();
const unique = <T>(values: readonly T[], key: (value: T) => string, label: string): void => {
  requireState(new Set(values.map(key)).size === values.length, 'LOGISTICS_MANIFEST', label + ' 包含重复身份。');
};
export function getLogisticsSubjectTypes(manifest: DeepReadonly<LogisticsManifest>): string[] {
  return [...new Set([...manifest.devices.map(spec => spec.deviceType), ...manifest.passiveSubjects.map(spec => spec.deviceType),
    ...manifest.dynamicGenerators.map(spec => spec.deviceType)])].sort();
}
export function readLogisticsManifest(logic: DeepReadonly<LogicManifest>): DeepReadonly<LogisticsManifest> {
  const hit = cache.get(logic); if (hit) return hit;
  const owners = [...logic.devices.map(device => ({ kind: 'device', item: device })), ...logic.generators.map(generator => ({ kind: 'generator', item: generator }))]
    .filter(owner => Object.hasOwn(owner.item.parameters, LOGISTICS_MANIFEST_KEY));
  requireState(owners.length === 1, 'LOGISTICS_MANIFEST_MISSING', '必须在一个明确 owner 的 parameters 中保存唯一完整物流发布清单；不能从当前场景或闭包补猜。');
  const manifest = copySafeJson(owners[0].item.parameters[LOGISTICS_MANIFEST_KEY]) as unknown as LogisticsManifest;
  validateJsonSchema(manifest, LOGISTICS_MANIFEST_SCHEMA, DEFAULT_STATE_BUDGETS, 'historyLogisticsManifest');
  requireState(manifest.owner.kind === owners[0].kind && manifest.owner.id === owners[0].item.id, 'LOGISTICS_MANIFEST', '物流发布清单 owner 不匹配。');
  const frozen = freezeData(manifest); cache.set(logic, frozen); return frozen;
}
/** 返回发布草稿，不更改调用方对象；发布者须在附加本清单之后计算 logicManifestHash。 */
export function withLogisticsManifest(logic: LogicManifest, manifest: LogisticsManifest): LogicManifest {
  const output = copySafeJson(logic) as unknown as LogicManifest, metadata = copySafeJson(manifest) as unknown as LogisticsManifest;
  validateJsonSchema(metadata, LOGISTICS_MANIFEST_SCHEMA, DEFAULT_STATE_BUDGETS, 'historyLogisticsManifest');
  const owner = metadata.owner.kind === 'device' ? output.devices.find(device => device.id === metadata.owner.id) : output.generators.find(generator => generator.id === metadata.owner.id);
  requireState(owner && owner.adapterId === LOGISTICS_ADAPTER_ID, 'LOGISTICS_MANIFEST', '清单 owner 必须属于 warehouse-logistics adapter。');
  for (const other of [...output.devices, ...output.generators]) requireState(other === owner || !Object.hasOwn(other.parameters, LOGISTICS_MANIFEST_KEY), 'LOGISTICS_MANIFEST', '其他 owner 已携带物流清单，不能静默覆盖。');
  owner.parameters[LOGISTICS_MANIFEST_KEY] = metadata as unknown as JsonObject;
  const requirement = { adapterId: LOGISTICS_ADAPTER_ID, version: LOGISTICS_ADAPTER_VERSION, stateSchemaVersion: LOGISTICS_STATE_SCHEMA_VERSION, deviceTypes: getLogisticsSubjectTypes(metadata) };
  const index = output.requiredAdapters.findIndex(item => item.adapterId === LOGISTICS_ADAPTER_ID);
  if (index < 0) output.requiredAdapters.push(requirement); else output.requiredAdapters[index] = requirement;
  for (const script of metadata.scripts) {
    const existing = output.businessScripts.find(item => item.id === script.id);
    requireState(!existing || existing.adapterId === LOGISTICS_ADAPTER_ID && existing.digest === script.digest, 'UNSUPPORTED_SCRIPT', '脚本已有不同版本或业务适配器声明。');
    if (!existing) output.businessScripts.push({ id: script.id, digest: script.digest, adapterId: LOGISTICS_ADAPTER_ID });
  }
  return output;
}
function unit(value: readonly number[], label: string): void { requireState(Math.abs(Math.hypot(...value) - 1) < 1e-6, 'LOGISTICS_GEOMETRY', label + ' 必须是已测量的单位世界轴。'); }
export function validateLogisticsLogic(logic: DeepReadonly<LogicManifest>, registeredTypes: readonly string[]): void {
  const manifest = readLogisticsManifest(logic), specs = [...manifest.devices, ...manifest.passiveSubjects];
  unique(specs, spec => spec.deviceId, '物流/被动主体'); unique(manifest.devices, spec => stableKey(spec.kind, String(spec.executionOrder)), '同类设备执行次序'); unique(manifest.locators, locator => locator.id, '定位线框');
  unique(manifest.cargoTemplates, template => template.id, '货箱模板'); unique(manifest.cargoGenerators, generator => generator.generatorId, '货箱生成器');
  unique(manifest.dynamicGenerators, generator => generator.generatorId, '动态生成器');
  unique(manifest.dynamicGenerators, generator => stableKey(generator.sourceId, generator.deviceType, generator.spawnerCode), '动态发生器匹配键');
  unique(manifest.fetchSources, source => source.sourceId, '库存来源'); unique(manifest.alarmRules, rule => rule.id, '报警规则'); unique(manifest.scripts, script => script.id, '业务脚本');
  unique(manifest.locators.flatMap(locator => locator.cells), cell => cell.slotId, '定位线框格口身份');
  requireState(getLogisticsSubjectTypes(manifest).every(type => registeredTypes.includes(type)), 'UNSUPPORTED_ADAPTER', '清单包含未显式注册的实际遥测主体类型。');
  const logical = new Map(logic.devices.map(device => [device.id, device])), models = new Map(logic.models.map(model => [model.id, model]));
  const templates = new Set(manifest.cargoTemplates.map(template => template.id)), generators = new Set(manifest.cargoGenerators.map(generator => generator.generatorId));
  const ids = new Set(specs.map(spec => spec.deviceId)), locatorIds = new Set(manifest.locators.map(locator => locator.id));
  for (const spec of specs) {
    const device = logical.get(spec.deviceId);
    requireState(device?.adapterId === LOGISTICS_ADAPTER_ID && device.modelId === spec.modelId && device.identity.sourceId === spec.sourceId
      && device.identity.assetCode === spec.assetCode && device.identity.deviceType === spec.deviceType, 'LOGISTICS_MANIFEST', '主体身份/实际类型/模型不匹配冻结绑定。');
    assertPose(spec.basePose);
    requireState(canonicalStringify(spec.basePose) === canonicalStringify(device.basePose), 'LOGISTICS_GEOMETRY', '逻辑设备的基准姿态与冻结元数据不符。');
  }
  for (const device of logic.devices) if (device.adapterId === LOGISTICS_ADAPTER_ID) requireState(ids.has(device.id), 'LOGISTICS_MANIFEST', '受管主体没有明确物流 kind 或被动角色，不能默认 ready。');
  const validateDeviceGeometry = (spec: DeepReadonly<LogisticsDeviceSpec>, dynamic: boolean): void => {
    unit(spec.travelAxis, '行走轴'); unit(spec.upAxis, '竖直轴'); unit(spec.forkAxis, '货叉轴');
    requireState(spec.worldBounds.min.every((n, i) => n <= spec.worldBounds.max[i]), 'LOGISTICS_GEOMETRY', '设备包围盒反转。');
    const model = models.get(spec.modelId); requireState(model, 'LOGISTICS_GEOMETRY', '物流模型没有逻辑锚点清单。');
    requireState(spec.kind === 'conveyor' || spec.motionParts.length > 0, 'LOGISTICS_GEOMETRY', '移动机构必须导出真实节点的 motionParts，不能用空几何冒充已迁移。');
    unique(spec.motionParts, part => part.channel, '运动通道');
    for (const part of spec.motionParts) requireState(part.channel !== 'root' && model.anchors.some(anchor => anchor.id === part.anchorId && anchor.channel === part.channel), 'LOGISTICS_GEOMETRY', '运动节点未映射到已发布逻辑 anchor/channel。');
    if (spec.cargoTemplateId !== null) requireState(templates.has(spec.cargoTemplateId), 'LOGISTICS_GEOMETRY', '默认/回退货箱没有实际尺寸。');
    if (spec.cargoGeneratorId !== null) requireState(generators.has(spec.cargoGeneratorId), 'LOGISTICS_GEOMETRY', '货箱规则生成器未冻结。');
    requireState(spec.kind === 'hclift' || spec.cargoTemplateId !== null, 'LOGISTICS_GEOMETRY', '货箱回退模板必须明确，不能依据加载完成时间改变行程。');
    const roles = spec.kind === 'stacker' || spec.kind === 'rgv' || spec.kind === 'lift' ? ['front', 'back'] as const
      : spec.kind === 'hclift' ? [] : ['single'] as const;
    const ports = roles.map(role => spec.cargoPorts[role]);
    requireState(ports.every(port => port !== null) && new Set(ports).size === ports.length, 'LOGISTICS_GEOMETRY', '持货工位缺少唯一逻辑端口。');
    for (const port of ports) {
      const anchorId = dynamic ? port : logical.get(spec.deviceId)?.ports.find(item => item.id === port)?.anchorId;
      requireState(anchorId && model.anchors.some(anchor => anchor.id === anchorId), 'LOGISTICS_GEOMETRY', '持货端口缺少发布模型内的数值锚点。');
    }
    if ('travelSpeed' in spec) requireState(spec.travelSpeed > 0, 'LOGISTICS_GEOMETRY', '行走速度必须由脚本/实例参数明确解析。');
    if ('liftSpeed' in spec) requireState(spec.liftSpeed > 0 && spec.liftLimits.min <= spec.liftLimits.max, 'LOGISTICS_GEOMETRY', '提升速度或行程缺失。');
    if ('forkSpeed' in spec) requireState(spec.forkSpeed > 0, 'LOGISTICS_GEOMETRY', '货叉速度缺失。');
    if (spec.kind === 'stacker') requireState(spec.rpmToMetersPerSecond > 0 && spec.forks.front.stroke >= 0 && spec.forks.back.stroke >= 0, 'LOGISTICS_GEOMETRY', '双叉尺度/换算系数无效。');
    if (spec.kind === 'shuttle') requireState(spec.deckTravelSpeed > 0 && spec.forkStroke >= 0 && spec.travelBodyHome.axisMin <= spec.travelBodyHome.axisMax, 'LOGISTICS_GEOMETRY', '穿梭车载货台行程事实缺失。');
    if (spec.kind === 'conveyor') {
      requireState(spec.span > 0 && spec.cargoSpeed > 0 && spec.movementFields.length > 0, 'LOGISTICS_GEOMETRY', '输送线跨度、速度或字段映射缺失。');
      for (const neighbor of [spec.probeNeighbors.forward, spec.probeNeighbors.reverse]) if (neighbor !== null) requireState(ids.has(neighbor), 'LOGISTICS_GEOMETRY', '静态探测邻居不在发布绑定中。');
      if (spec.platformLocatorId !== null) requireState(locatorIds.has(spec.platformLocatorId), 'LOGISTICS_GEOMETRY', '输送线站台定位线框缺失。');
    }
    if (spec.kind === 'hclift') requireState(locatorIds.has(spec.platformLocatorId), 'LOGISTICS_GEOMETRY', '小车提升机缺少换层站台。');
    if (spec.kind === 'lift' && spec.cargoAxis) unit(spec.cargoAxis, '双工位货物轨迹轴');
  };
  for (const spec of manifest.devices) validateDeviceGeometry(spec, false);
  for (const generator of manifest.dynamicGenerators) {
    const declared = logic.generators.find(item => item.id === generator.generatorId);
    requireState(declared?.adapterId === LOGISTICS_ADAPTER_ID && declared.modelId === generator.modelId && declared.sourceId === generator.sourceId
      && declared.deviceType === generator.deviceType && declared.ttlMs === generator.ttlMs && models.has(generator.modelId)
      && generator.template.modelId === generator.modelId && generator.template.sourceId === generator.sourceId
      && generator.template.deviceType === generator.deviceType, 'LOGISTICS_MANIFEST', '动态模板、来源或 TTL 与逻辑生成器不符。');
    requireState(generator.timeoutMs === null ? generator.ttlMs === null : generator.ttlMs === generator.timeoutMs + 1,
      'LOGISTICS_TTL', '有效 TTL 必须保留旧严格大于 timeoutMs 的边界。');
    if (generator.template.kind !== 'passive') validateDeviceGeometry(generator.template, true);
  }
  for (const template of manifest.cargoTemplates) requireState(template.bounds.min.every((n, i) => n <= template.bounds.max[i]), 'LOGISTICS_GEOMETRY', '货箱模板包围盒反转。');
  for (const generator of manifest.cargoGenerators) for (const templateId of [generator.defaultTemplateId, ...generator.rules.map(rule => rule.templateId)]) {
    if (templateId !== null) requireState(templates.has(templateId), 'LOGISTICS_GEOMETRY', '条件货箱模板缺少冻结尺寸。');
  }
  for (const locator of manifest.locators) {
    assertPose(locator.rootPose); unique(locator.cells, cell => stableKey(String(cell.column), String(cell.layer)), '格口坐标');
    requireState(locator.cells.length === locator.columns * locator.layers, 'LOGISTICS_GEOMETRY', '定位线框必须包含每一个实际格口，不可留几何占位。');
    for (const cell of locator.cells) {
      const slot = logic.slots.find(slot => slot.id === cell.slotId);
      requireState(slot?.locatorId === locator.id && slot.column === cell.column && slot.layer === cell.layer
        && (locator.fetchRow === null || slot.row === locator.fetchRow)
        && canonicalStringify(slot.pose) === canonicalStringify(cell.pose), 'LOGISTICS_GEOMETRY', '格口支撑位或库存排与 LogicManifest.slots 不一致。');
    }
    if (locator.hostDeviceId !== null) requireState(ids.has(locator.hostDeviceId), 'LOGISTICS_GEOMETRY', '站台宿主不在发布清单。');
    requireState((locator.fetchRow === null) === (locator.fetchSourceId === null), 'LOGISTICS_FETCH', '库存定位线框必须同时声明来源和排。');
    if (locator.fetchSourceId !== null) requireState(manifest.fetchSources.some(source => source.sourceId === locator.fetchSourceId && source.rowKeys.includes(locator.fetchRow!)), 'LOGISTICS_FETCH', '库存排没有来源合同。');
    if (locator.cargoTemplateId !== null) requireState(templates.has(locator.cargoTemplateId), 'LOGISTICS_GEOMETRY', '库存回退货箱尺寸缺失。');
    if (locator.cargoGeneratorId !== null) requireState(generators.has(locator.cargoGeneratorId), 'LOGISTICS_GEOMETRY', '库存货箱规则未冻结。');
  }
  for (const source of manifest.fetchSources) {
    requireState(logic.sources.some(item => item.id === source.sourceId) && source.rowKeys.length > 0, 'LOGISTICS_FETCH', '库存来源或其作用排没有冻结。');
    unique(source.rowKeys, row => row, '库存排');
    for (const row of source.rowKeys) requireState(manifest.locators.some(locator => locator.fetchSourceId === source.sourceId && locator.fetchRow === row),
      'LOGISTICS_FETCH', '库存来源的作用排没有对应定位线框。');
  }
  for (const rule of manifest.alarmRules) requireState(ids.has(rule.deviceId), 'LOGISTICS_ALARM_SUBJECT', '报警目标必须是显式物流设备或被动遥测主体，不得伪装成另一类驱动。');
  const scripts = logic.businessScripts.filter(script => script.adapterId === LOGISTICS_ADAPTER_ID);
  requireState(scripts.length === manifest.scripts.length && scripts.every(script => manifest.scripts.some(item => item.id === script.id && item.digest === script.digest)), 'UNSUPPORTED_SCRIPT', '业务脚本集合必须与冻结清单精确一致。');
}

export function cargoReferences(value: LogisticsDriverState): { id: string; role: 'front' | 'back' | 'single' | 'step1' | 'step2' }[] {
  if (value.kind === 'stacker' || value.kind === 'rgv') return (['front', 'back'] as const).flatMap(role => value[role].cargoId ? [{ id: value[role].cargoId!, role }] : []);
  if (value.kind === 'conveyor' || value.kind === 'shuttle') return value.cargoId ? [{ id: value.cargoId, role: 'single' }] : [];
  if (value.kind === 'lift') return value.stations.flatMap((station, index) => station.cargoId ? [{ id: station.cargoId, role: index === 0 ? 'step1' as const : 'step2' as const }] : []);
  return [];
}
/** 值已过严格 schema；额外核对候选全态中的承运者、共享占位、查询时钟和报警关系。 */
export function validateLogisticsState(value: DeepReadonly<JsonObject>, view: StateReadView): void {
  const state = value as unknown as DeepReadonly<LogisticsAdapterValue>, manifest = readLogisticsManifest(view.logic);
  const needCounter = (namespace: string, value: string): void => {
    const counter = view.get('counters', stableKey('counter', namespace));
    requireState(counter && compareDecimal(counter.value, value) >= 0, 'LOGISTICS_BASELINE', '运行事实的生成/登记次序计数缺失。');
  };
  if (state.kind === 'raw-telemetry') {
    assertLogisticsRawTelemetry(state as RawTelemetryState, view); return;
  }
  if (state.kind === 'cargo') {
    const cargo = view.get('cargo', state.cargoId), record = view.get('adapterStates', stableKey('logistics-cargo', state.cargoId));
    requireState(cargo && cargo.destroyedAt === null && record?.state.value === value && record.cargoIds.length === 1 && record.cargoIds[0] === cargo.id
      && (cargo.host?.kind === 'device' ? record.deviceIds.length === 1 && record.deviceIds[0] === cargo.host.deviceId : record.deviceIds.length === 0),
    'LOGISTICS_CARGO', '货物运行记录与唯一生命周期、宿主引用不一致。');
    requireState(manifest.cargoTemplates.some(template => template.id === state.templateId) && !(state.retained && state.awaitingFetch), 'LOGISTICS_CARGO', '货物模板或留存语义不一致。');
    needCounter('logistics-ownership', state.ownershipOrder); assertPose(state.worldPose);
    if (state.handoff) assertPose(state.handoff.from);
    if (cargo.host?.kind === 'device') requireState(state.ownerDeviceId === cargo.host.deviceId && state.ownerRole !== null && !state.retained && !state.awaitingFetch, 'LOGISTICS_CARGO', '货物宿主与承运状态不一致。');
    if (cargo.host?.kind === 'slot') {
      const slotId = cargo.host.slotId;
      requireState(state.ownerDeviceId === null && state.ownerRole === null, 'LOGISTICS_CARGO', '入格货物不能继续登记设备承运者。');
      if (state.awaitingFetch) requireState([...view.values('fetchRows')].some(row => row.pendingSettlement.some(item => item.cargoId === cargo.id && item.slotId === slotId)),
        'LOGISTICS_CARGO', '等待库存清算的货物缺少对应格口的待清算关系。');
      const locator = manifest.locators.find(item => item.cells.some(cell => cell.slotId === slotId));
      if (state.retained && locator?.fetchSourceId && locator.fetchRow) {
        requireState(view.get('fetchRows', fetchRowId(locator.fetchSourceId, locator.fetchRow))?.persistentSuppressedSlotIds.includes(slotId),
          'LOGISTICS_CARGO', '留存货物缺少对应格口的持久抑制。');
      }
    }
    return;
  }
  if (state.kind === 'uninstantiated') {
    const key = deviceIdentityKey(state.identity);
    const parked = view.get('adapterStates', stableKey('logistics-uninstantiated', key));
    requireState(parked?.state.value === value && parked.deviceIds.length === 0 && parked.cargoIds.length === 0
      && state.identity.projectId === view.logic.versions.projectId
      && view.logic.sources.some(source => source.id === state.identity.sourceId)
      && ![...view.values('devices')].some(device => deviceIdentityKey(device.identity) === key),
    'LOGISTICS_LIFECYCLE', '停放遥测必须属于已绑定来源，且不能与活动实例同时存在。');
    requireState(state.lastReceiptAt <= view.metadata.logicalTime && (state.retiredAt === null || state.retiredAt <= view.metadata.logicalTime),
      'LOGISTICS_LIFECYCLE', '停放遥测不能引用未来的观测或退休时间。');
    if (state.generatorId !== null || state.generation !== null || state.lastDeviceId !== null || state.retiredAt !== null) {
      const generator = manifest.dynamicGenerators.find(item => item.generatorId === state.generatorId);
      requireState(generator && generator.sourceId === state.identity.sourceId && generator.deviceType === state.identity.deviceType
        && state.generation !== null && state.retiredAt !== null
        && state.lastDeviceId === dynamicDeviceId(state.identity, generator.generatorId, state.generation),
      'LOGISTICS_LIFECYCLE', '退休主体必须保留匹配的生成器、实例代次和退休时间。');
      needCounter(stableKey('generator', generator.generatorId), state.generation);
    }
    const { previous, current, effectiveHeartbeatAt } = state.telemetry;
    requireState(!previous || current && previous.receivedAt <= current.receivedAt, 'LOGISTICS_LIFECYCLE', '停放遥测前后帧顺序无效。');
    for (const frame of [previous, current]) if (frame) requireState(frame.receivedAt <= view.metadata.logicalTime
      && compareInputCursor(frame.inputCursor, view.metadata.inputCursor) <= 0, 'LOGISTICS_LIFECYCLE', '停放遥测引用未来输入。');
    if (current) requireState(effectiveHeartbeatAt !== null && effectiveHeartbeatAt >= current.receivedAt
      && effectiveHeartbeatAt <= view.metadata.logicalTime && current.deviceEpoch === state.ordering.deviceEpoch,
    'LOGISTICS_LIFECYCLE', '停放遥测的纪元或有效心跳不一致。');
    if (state.ordering.lastInputCursor) requireState(compareInputCursor(state.ordering.lastInputCursor, view.metadata.inputCursor) <= 0,
      'LOGISTICS_LIFECYCLE', '停放遥测排序游标不能位于未来。');
    return;
  }
  if (state.kind === 'clock') {
    if (state.timerId !== null) requireState(view.get('timers', state.timerId)?.adapterId === LOGISTICS_ADAPTER_ID, 'LOGISTICS_CLOCK', '逻辑时钟丢失了下一截止任务。');
    return;
  }
  if (state.kind === 'alarm') {
    const alarm = [...view.values('alarms')].find(alarm => alarm.state.value === value);
    requireState(alarm && alarm.id === alarm.ruleId && manifest.alarmRules.some(rule => rule.id === alarm.ruleId && rule.deviceId === alarm.deviceId)
      && alarm.active === (state.trigger !== null), 'LOGISTICS_ALARM', '报警规则/主体/活跃态与保留状态不匹配。'); return;
  }
  const device = [...view.values('devices')].find(device => device.driverState.value === value);
  requireState(device, 'LOGISTICS_BASELINE', '驱动/被动主体状态没有对应的设备记录。');
  const spec = device.dynamic ? manifest.dynamicGenerators.find(generator => generator.generatorId === device.dynamic!.generatorId)?.template
    : [...manifest.devices, ...manifest.passiveSubjects].find(spec => spec.deviceId === device.logicalDeviceId);
  requireState(spec?.kind === state.kind, 'LOGISTICS_BASELINE', '存量设备缺少对应的完整、同类 driverState。');
  if (device.dynamic) { requireState(state.birthOrder !== null, 'LOGISTICS_BASELINE', '动态实例缺少真实生成次序。'); needCounter('logistics-birth', state.birthOrder); }
  if (state.kind !== 'passive') {
    const activeSpec = spec as DeepReadonly<LogisticsDeviceSpec>;
    for (const held of cargoReferences(state as LogisticsDriverState)) {
      const cargo = view.get('cargo', held.id), host = cargo?.host;
      const role = held.role === 'step1' ? 'front' : held.role === 'step2' ? 'back' : held.role;
      requireState(cargo?.destroyedAt === null && host?.kind === 'device' && host.deviceId === device.id && host.portId === activeSpec.cargoPorts[role],
        'LOGISTICS_CARGO', '驱动持货引用不等于货物唯一宿主/工位。');
    }
    if (state.kind === 'hclift' && state.occupancy) requireState(view.get('devices', state.occupancy.shuttleId)?.driverState.value.kind === 'shuttle', 'LOGISTICS_BASELINE', '载货台占位引用缺失的小车。');
    if (state.kind === 'shuttle' && state.hcliftOccupancyId !== null) requireState(view.get('devices', state.hcliftOccupancyId)?.driverState.value.kind === 'hclift', 'LOGISTICS_BASELINE', '小车占位引用缺失的提升机。');
  }
  for (const cargo of view.values('cargo')) if (cargo.destroyedAt === null && cargo.host?.kind === 'device' && cargo.host.deviceId === device.id) {
    const record = view.get('adapterStates', stableKey('logistics-cargo', cargo.id));
    const meta = record?.state.value as unknown as CargoRuntimeState | undefined;
    const held = state.kind !== 'passive' ? cargoReferences(state as LogisticsDriverState).find(item => item.id === cargo.id) : undefined;
    requireState(meta?.kind === 'cargo' && meta.ownerDeviceId === device.id && held && meta.ownerRole === held.role,
      'LOGISTICS_CARGO', '物流设备持货、承运角色与唯一宿主不一致，或被动主体被伪装为物流承运者。');
  }
}

/** 全域事实独立于任何设备记录校验；空设备表不能绕过库存、报警或时钟要求。 */
export function validateLogisticsView(view: StateReadView): void {
  const manifest = readLogisticsManifest(view.logic);
  for (const source of manifest.fetchSources) for (const row of source.rowKeys) {
    const fact = view.get('fetchRows', fetchRowId(source.sourceId, row));
    requireState(fact && fact.inventoryRevision !== null, 'LOGISTICS_BASELINE', '完整基线缺少逐排库存修订、查询代次或抑制/清算状态。');
    for (const pending of fact.pendingSettlement) {
      const cargo = view.get('cargo', pending.cargoId), meta = view.get('adapterStates', stableKey('logistics-cargo', pending.cargoId))?.state.value;
      requireState(cargo?.host?.kind === 'slot' && cargo.host.slotId === pending.slotId && meta?.kind === 'cargo' && meta.awaitingFetch === true,
        'LOGISTICS_BASELINE', '待清算项必须对应在该格口等待库存确认的货物。');
    }
  }
  for (const rule of manifest.alarmRules) {
    requireState(view.get('alarms', rule.id), 'LOGISTICS_BASELINE', '完整基线缺少报警规则的保留点位/原激活态。');
  }
  const clocks = getLogisticsClockSpecs(manifest), expectedTimerIds = new Set<string>();
  for (const spec of clocks) {
    const record = view.get('adapterStates', stableKey('logistics-clock', spec.name));
    const state = record?.state.value;
    const timer = typeof state?.timerId === 'string' ? view.get('timers', state.timerId) : undefined;
    requireState(record?.state.adapterId === LOGISTICS_ADAPTER_ID && record.deviceIds.length === 0 && record.cargoIds.length === 0
      && state?.kind === 'clock' && state.phase === spec.name && timer?.adapterId === LOGISTICS_ADAPTER_ID
      && timer.adapterVersion === LOGISTICS_ADAPTER_VERSION && timer.timerType === spec.timerType && timer.phase === spec.phase
      && timer.deviceId === null && timer.cargoId === null && canonicalStringify(timer.payload) === canonicalStringify(spec.payload)
      && timer.dueAt >= manifest.frameAnchorAt && (timer.dueAt - manifest.frameAnchorAt) % spec.period === 0
      && (state.lastAt === null || typeof state.lastAt === 'number' && state.lastAt <= view.metadata.logicalTime && timer.dueAt === state.lastAt + spec.period),
    'LOGISTICS_BASELINE', '完整基线缺少与固定调度合同一致的时钟或下一截止任务。');
    requireState(!expectedTimerIds.has(timer.id), 'LOGISTICS_BASELINE', '不同逻辑时钟不能共用同一定时任务。');
    if (state.lastAt === null && view.metadata.continuity.status === 'complete') {
      const now = view.metadata.logicalTime, anchor = manifest.frameAnchorAt;
      const first = now < anchor ? anchor : anchor + Math.ceil((now - anchor) / spec.period) * spec.period;
      requireState(timer.dueAt === first || first === now && timer.dueAt === now + spec.period,
        'LOGISTICS_BASELINE', '未执行过的时钟跳过了最近的逻辑截止时间。');
    }
    expectedTimerIds.add(timer.id);
  }
  for (const record of view.values('adapterStates')) if (record.state.adapterId === LOGISTICS_ADAPTER_ID && record.state.value.kind === 'clock') {
    const phase = record.state.value.phase;
    requireState(typeof phase === 'string' && clocks.some(spec => spec.name === phase) && record.id === stableKey('logistics-clock', phase),
      'LOGISTICS_BASELINE', '检查点包含清单之外的逻辑时钟。');
  }
  for (const timer of view.values('timers')) if (timer.adapterId === LOGISTICS_ADAPTER_ID) {
    if (timer.timerType !== 'expire') requireState(expectedTimerIds.has(timer.id), 'LOGISTICS_BASELINE', '检查点包含游离的周期定时任务。');
    else {
      const deviceId = timer.payload.deviceId, generation = timer.payload.generation;
      const device = typeof deviceId === 'string' ? view.get('devices', deviceId) : undefined;
      requireState(device?.dynamic && timer.phase === 'lifecycle' && timer.deviceId === device.id && timer.cargoId === null
        && device.dynamic.generation === generation && device.dynamic.expiryTimerId === timer.id && device.dynamic.expiresAt === timer.dueAt,
      'LOGISTICS_BASELINE', '动态实例到期任务没有匹配的生成代次和截止时间。');
    }
  }
  const births = new Set<string>();
  for (const device of view.values('devices')) if (device.dynamic && device.driverState.adapterId === LOGISTICS_ADAPTER_ID) {
    const order = device.driverState.value.birthOrder;
    requireState(typeof order === 'string' && !births.has(order), 'LOGISTICS_BASELINE', '动态主体的生成顺序必须唯一。');
    births.add(order);
  }
  const slotIds = new Set(manifest.locators.flatMap(locator => locator.cells.map(cell => cell.slotId)));
  for (const cargo of view.values('cargo')) {
    if (cargo.destroyedAt !== null || !cargo.host) continue;
    const managed = cargo.host.kind === 'device' ? view.get('devices', cargo.host.deviceId)?.driverState.adapterId === LOGISTICS_ADAPTER_ID
      : cargo.host.kind === 'slot' && slotIds.has(cargo.host.slotId);
    if (managed) requireState(view.get('adapterStates', stableKey('logistics-cargo', cargo.id))?.state.value.kind === 'cargo',
      'LOGISTICS_BASELINE', '物流宿主上的活货物缺少真实模板及可恢复的交接状态。');
  }
}
