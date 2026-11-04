import type { DeviceIdentity, DeviceType, JsonValue, LogicManifest, NumericPose, TelemetryFrame, Vec3 } from '../state/types';

export const LOGISTICS_ADAPTER_ID = 'warehouse-logistics' as const;
export const LOGISTICS_ADAPTER_VERSION = 'legacy-semantics/2' as const;
export const LOGISTICS_STATE_SCHEMA_VERSION = '2' as const;
export const LOGISTICS_MANIFEST_KEY = 'historyLogisticsManifest' as const;
export const LOGISTICS_MANIFEST_FORMAT = 'warehouse-logistics-manifest/1' as const;
export type ForkSide = 'front' | 'back';
export type FrozenBounds = { min: Vec3; max: Vec3 };
export type FrozenRange = { min: number; max: number };
export type LogisticsScriptProfile = 'stacker' | 'conveyor' | 'hclift' | 'shuttle' | 'rgv' | 'lift' | 'storage' | 'cargo' | 'passive';
export type LogisticsScriptBinding = { id: string; digest: string; profile: LogisticsScriptProfile };

/** 发布器从真实运动节点及父级矩阵导出；不允许 worker 根据名称猜测 Mesh。 */
export type FrozenMotionPart = {
  anchorId: string; channel: string;
  /** 旧 offsetNodesFromBaselineByWorldOffsets 的世界向量到父级局部向量基，列主序 3×3。 */
  worldToParent: [number, number, number, number, number, number, number, number, number];
  travel: boolean; lift: boolean; frontFork: number; backFork: number; shuttleFork: number;
};
export type FrozenCell = { slotId: string; column: number; layer: number; pose: NumericPose };
export type FrozenLocator = {
  id: string; kind: 'storage' | 'platform' | 'layer-change';
  deviceAssetCode: string; aisleCode: string; row: number; depth: 'near' | 'far';
  startColumn: number; startLayer: number; columns: number; layers: number; columnReversed: boolean;
  cells: FrozenCell[]; rootPose: NumericPose; platformTrackEndWorld: Vec3 | null;
  retainCargo: boolean; hostDeviceId: string | null;
  fetchSourceId: string | null; fetchRow: string | null; cargoGeneratorId: string | null; cargoTemplateId: string | null;
};
export type FrozenCargoTemplate = {
  id: string; generatorId: string | null; targetSignature: string;
  /** 模板自身坐标、底部支撑点为原点；含最终参数化缩放，不能用异步加载中的回退尺寸。 */
  bounds: FrozenBounds;
};
export type FrozenCargoRule = { attributeName: string; attributeValue: string; templateId: string | null };
export type FrozenCargoGenerator = { generatorId: string; defaultTemplateId: string | null; rules: FrozenCargoRule[] };
export type FrozenTarget = { entityId: string; deviceId: string | null; pose: NumericPose };
export type FrozenColumnBinding = { column: number; targets: FrozenTarget[] };
export type FrozenLayerBinding = { layer: number; targets: FrozenTarget[] };

export type FrozenDeviceBase = {
  deviceId: string; kind: DeviceType; deviceType: string; modelId: string; sourceId: string; assetCode: string;
  /** collectModels/candidate 的稳定遍历次序，影响首次登记的订阅者和同 task 接管仲裁。 */
  executionOrder: number;
  basePosition: Vec3; basePose: NumericPose; worldBounds: FrozenBounds; travelAxis: Vec3; upAxis: Vec3; forkAxis: Vec3;
  staleAfterMs: number; motionParts: FrozenMotionPart[];
  cargoTemplateId: string | null; cargoGeneratorId: string | null;
  /** 端口必须同时出现在 LogicManifest 的 devices.ports（动态设备使用模型 anchorId）。 */
  cargoPorts: { front: string | null; back: string | null; single: string | null };
};
export type StackerSpec = FrozenDeviceBase & {
  kind: 'stacker'; targetReference: Vec3; travelLimits: FrozenRange | null; liftLimits: FrozenRange;
  travelSpeed: number; liftSpeed: number; forkSpeed: number; cargoGapY: number; rpmToMetersPerSecond: number;
  forks: { front: { anchor: Vec3; centerHome: Vec3; stroke: number }; back: { anchor: Vec3; centerHome: Vec3; stroke: number } };
};
export type ConveyorSpec = FrozenDeviceBase & {
  kind: 'conveyor'; center: Vec3; span: number; surfaceLift: number; forwardSign: 1 | -1;
  movementFields: string[]; actionMap: { [key: string]: number }; cargoSpeed: number;
  frontHasGoodsField: string; backHasGoodsField: string; cargoAutoDispose: boolean; cargoOriginDevice: boolean;
  probeNeighbors: { forward: string | null; reverse: string | null };
  perpendicularEnds: { positive: number | null; negative: number | null };
  platformLocatorId: string | null;
};
export type HcliftSpec = FrozenDeviceBase & {
  kind: 'hclift'; aisleCode: string; liftSpeed: number; liftLimits: FrozenRange;
  deckCenterBase: Vec3; deckTopBase: number; platformLocatorId: string;
};
export type ShuttleSpec = FrozenDeviceBase & {
  kind: 'shuttle'; aisleCode: string; targetReference: Vec3; travelLimits: FrozenRange | null;
  travelSpeed: number; forkSpeed: number; deckTravelSpeed: number; forkStroke: number; forkCenterHome: Vec3;
  forkAnchor: Vec3; cargoBaseHomeY: number; travelBodyHome: { center: Vec3; axisMin: number; axisMax: number };
};
export type RgvSpec = FrozenDeviceBase & {
  kind: 'rgv'; travelSpeed: number; travelLimits: FrozenRange | null; columns: FrozenColumnBinding[];
  stations: { front: { anchor: Vec3; bounds: FrozenBounds }; back: { anchor: Vec3; bounds: FrozenBounds } };
};
export type LiftSpec = FrozenDeviceBase & {
  kind: 'lift'; liftSpeed: number; liftLimits: FrozenRange; deckTopBase: number;
  /** getLiftStationPose 的顶面中心（原 world bounds 中心再令 y=maxY），不是 hclift 的几何中心。 */
  deckCenterBase: Vec3; cargoAxis: Vec3 | null;
  stationOffset: number; incomingLayers: FrozenLayerBinding[]; outgoingLayers: FrozenLayerBinding[];
};
export type LogisticsDeviceSpec = StackerSpec | ConveyorSpec | HcliftSpec | ShuttleSpec | RgvSpec | LiftSpec;
export type PassiveSubjectSpec = {
  kind: 'passive'; role: 'alarm-telemetry'; deviceId: string; deviceType: string; modelId: string;
  sourceId: string; assetCode: string; executionOrder: number; basePose: NumericPose; staleAfterMs: number;
};
export type FrozenAlarmRule = {
  id: string; managerId: string; targetEntityId: string; deviceId: string; enabled: boolean; telemetryEnabled: boolean;
  listenProperty: 'RUNNING STATE' | 'CUSTOM PROPERTY'; runningState: 'offline' | 'idle' | 'running' | 'alarm';
  customProperty: string; customValue: string; warehouseAlarm: boolean; staleAfterMs: number;
};
export type FrozenDynamicGenerator = {
  generatorId: string; spawnerCode: string; sourceId: string; deviceType: string; modelId: string; template: LogisticsDeviceSpec | PassiveSubjectSpec;
  /** 原 timeoutSeconds×1000；有效 ttlMs=timeoutMs+1，保留整数观测下严格大于的旧判定。 */
  timeoutMs: number | null; ttlMs: number | null;
};
export type FrozenFetchSource = { sourceId: string; rowKeys: string[]; syncIntervalMs: number };

/** 该对象随 LogicManifest 参数序列化，注册表不得仅在闭包中保留未入 checkpoint 的配置。 */
export type LogisticsManifest = {
  format: typeof LOGISTICS_MANIFEST_FORMAT;
  owner: { kind: 'device' | 'generator'; id: string };
  /** 固定逻辑帧步长及 UTC 对齐锚点属于执行版本，不能取浏览器 FPS。 */
  fixedStepMs: number; frameAnchorAt: number;
  devices: LogisticsDeviceSpec[]; passiveSubjects: PassiveSubjectSpec[]; locators: FrozenLocator[];
  cargoTemplates: FrozenCargoTemplate[]; cargoGenerators: FrozenCargoGenerator[];
  dynamicGenerators: FrozenDynamicGenerator[]; fetchSources: FrozenFetchSource[]; alarmRules: FrozenAlarmRule[];
  scripts: LogisticsScriptBinding[];
};
export type LogisticsTelemetryPayload = { deviceId: string | null; identity: DeviceIdentity; frame: TelemetryFrame };
/** 每条仅携带来源实际更新的原始字段，业务完整帧由受控 reducer 在同一事务内计算。 */
export type LogisticsRawTelemetryRecord = {
  identity: DeviceIdentity; mode: 'full' | 'delta'; fields: TelemetryFrame['fields'];
  receivedAt: number; sourceTimestamp: number | null; sequence: string | null; deviceEpoch: string;
  eventId: string | null; inputCursor: TelemetryFrame['inputCursor']; topic: string;
  payloadDeviceCode: string | null; spawnerCode: string | null;
};
export type LogisticsTelemetryBatchPayload = { records: LogisticsRawTelemetryRecord[] };
export type InventoryContainerRecord = {
  containerCode: string; containerType: string; isEmpty: boolean; locType: string; row: string;
  column: number; layer: number; tier: number; stackingRow: string; stackingColumn: number; stackingLayer: number;
  [key: string]: JsonValue;
};
export type LogisticsManifestCarrier = Pick<LogicManifest, 'devices' | 'generators'>;

/** 这些事实必须来自对齐的权威基线/采集日志，不能从场景布局或最后一个 payload 推导。 */
export const LOGISTICS_REQUIRED_RUNTIME_FACTS = [
  'telemetry.previous/current、有效心跳、设备/来源 epoch 和去重水位',
  '增量来源每主体的原始字段、事件去重证据及与来源边界一致的完整基线',
  '六类 driver 的动作边沿、取放锁存、叉位、双工位、当前交接阶段及未完成定时器',
  '每件存量货物的稳定 cargoId、实际宿主/库位、task/container 别名和生成来源',
  'conveyor taskPulse、上下游订阅、externalPull、transitedTasks、自驱和复用宽限',
  'hclift 台面与 shuttle 占位/进出梯锁存及其最后报文时间',
  'Fetch operationEpoch、逐排请求代际、attempt、瞬态/持久抑制和待清算货物',
  '动态实例出生/心跳/TTL、生成计数、报警保留点位与原激活时间',
] as const;
